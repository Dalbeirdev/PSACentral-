import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign as edSign, verify as edVerify } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  claimsSegment,
  decodeLicenseToken,
  encodeLicenseToken,
  LICENSE_GRACE_DAYS,
  LICENSE_TOKEN_TTL_DAYS,
  type LicenseRenewal,
  type LicenseSigningKeyInfo,
  type LicenseTokenClaims,
} from '@psacc/contracts';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import type { Queryable } from '../../database/database.service.js';

type Row = Record<string, unknown>;
/** PKCS#8 prefix for an Ed25519 private key: the 32-byte seed follows. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Module 16 — issues and verifies appliance license tokens. The signing key is the `LICENSE_SIGNING_KEY`
 * secret (Ed25519 seed); its public key is what edge images pin at build time (`LICENSE_PUBLIC_KEY`).
 */
@Injectable()
export class LicenseTokensService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  readonly info: LicenseSigningKeyInfo;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, config.secrets.licenseSigningKey]), format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey(this.privateKey);
    const spki = this.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    this.info = {
      keyId: createHash('sha256').update(spki).digest('hex').slice(0, 16),
      publicKeyPem: this.publicKey.export({ format: 'pem', type: 'spki' }) as string,
      publicKeySpkiBase64: spki.toString('base64'),
      tokenTtlDays: LICENSE_TOKEN_TTL_DAYS,
      graceDays: LICENSE_GRACE_DAYS,
    };
  }

  /** Signs claims into a token. */
  sign(claims: LicenseTokenClaims): string {
    const signature = edSign(null, Buffer.from(claimsSegment(claims), 'ascii'), this.privateKey);
    return encodeLicenseToken(claims, new Uint8Array(signature));
  }

  /** Verifies a token's signature against a public key (PEM); returns the claims or null. Used by tests and diagnostics. */
  static verify(token: string, publicKeyPem: string): LicenseTokenClaims | null {
    try {
      const d = decodeLicenseToken(token);
      const ok = edVerify(null, Buffer.from(d.signedBytes), createPublicKey(publicKeyPem), Buffer.from(d.signature));
      return ok ? d.claims : null;
    } catch {
      return null;
    }
  }

  /**
   * The licensing answer for a deployment, inside the caller's tenant transaction: a fresh token while the
   * deployment's license is active and in term and the deployment is not suspended or decommissioned;
   * otherwise `inactive` (the appliance stops PSA work) or `none` (no license bound).
   */
  async renewalFor(q: Queryable, deploymentId: string, installationId: string | null): Promise<LicenseRenewal> {
    const r = await q.maybeOne<Row>(
      `SELECT d.code, d.organization_id, d.client_id, d.lifecycle_state, d.installation_id,
              l.id AS license_id, l.code AS license_code, l.display_name AS plan, l.status AS license_status, l.ends_at,
              (l.ends_at IS NOT NULL AND l.ends_at < current_date) AS license_past
       FROM deployments d LEFT JOIN licenses l ON l.id = d.license_id WHERE d.id = $1`,
      [deploymentId],
    );
    if (!r) return { state: 'none', token: null, licenseCode: null, reason: 'Deployment not found.' };
    const inst = installationId ?? (r.installation_id as string | null);
    if (!r.license_id) return { state: 'none', token: null, licenseCode: null, reason: 'No license is bound to this deployment.' };
    const code = r.license_code as string;
    if (r.lifecycle_state === 'decommissioned') return { state: 'inactive', token: null, licenseCode: code, reason: 'The deployment is decommissioned.' };
    if (r.lifecycle_state === 'suspended') return { state: 'inactive', token: null, licenseCode: code, reason: 'The deployment is suspended.' };
    if (r.license_status !== 'active') return { state: 'inactive', token: null, licenseCode: code, reason: `License ${code} is ${r.license_status}.` };
    if (r.license_past) return { state: 'inactive', token: null, licenseCode: code, reason: `License ${code} ended on ${ymd(r.ends_at)}.` };
    if (!inst) return { state: 'none', token: null, licenseCode: code, reason: 'No installation identity yet.' };
    const now = new Date();
    const claims: LicenseTokenClaims = {
      v: 1,
      keyId: this.info.keyId,
      licenseId: r.license_id as string,
      licenseCode: code,
      plan: r.plan as string,
      organizationId: r.organization_id as string,
      clientId: r.client_id as string,
      deploymentId,
      deploymentCode: r.code as string,
      installationId: inst,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LICENSE_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
      licenseEndsAt: ymd(r.ends_at),
      graceDays: LICENSE_GRACE_DAYS,
    };
    return { state: 'active', token: this.sign(claims), licenseCode: code, reason: null };
  }
}

function ymd(v: unknown): string | null {
  return v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : null;
}
