import { z } from 'zod';

/**
 * Module 16 — Offline-verifiable license tokens.
 *
 * The Control Plane signs a short-lived token (Ed25519) that binds a license to one deployment and one
 * installation. The package carries the first token; every heartbeat carries a renewed one. The appliance
 * verifies the signature against the public key pinned in its image (or, for images built without one,
 * the key shipped in the package), checks the binding and the dates, and refuses PSA work when the token
 * is missing, invalid, revoked, bound to another appliance, or expired beyond the grace period. A Control
 * Plane outage therefore never stops a client inside the token's validity plus grace (AD-13), while a
 * copied image, a copied package or a lapsed license does not run.
 *
 * Wire format: `psacc-lic.v1.<base64url(claims JSON)>.<base64url(signature)>`. The signature covers the
 * exact base64url claim bytes, so verifiers never re-serialize JSON (no canonicalization to get wrong).
 */
export const LICENSE_TOKEN_PREFIX = 'psacc-lic.v1.';
/** Validity of each token; renewed with every heartbeat long before it ends. */
export const LICENSE_TOKEN_TTL_DAYS = 30;
/** After the token's expiry the appliance keeps working this many days (Control Plane unreachable), then stops PSA work. */
export const LICENSE_GRACE_DAYS = 14;

const iso = z.iso.datetime({ offset: true });
export const licenseTokenClaimsSchema = z.strictObject({
  v: z.literal(1),
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  licenseId: z.uuid(),
  licenseCode: z.string().regex(/^LIC-\d{5,}$/),
  plan: z.string().min(1).max(120),
  organizationId: z.uuid(),
  clientId: z.uuid(),
  deploymentId: z.uuid(),
  deploymentCode: z.string().regex(/^DEP-\d{5,}$/),
  installationId: z.uuid(),
  issuedAt: iso,
  expiresAt: iso,
  /** The license term's end (date), or null for a perpetual license. */
  licenseEndsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  graceDays: z.number().int().min(0).max(90),
});
export type LicenseTokenClaims = z.infer<typeof licenseTokenClaimsSchema>;

/** Appliance-side verification outcome, as reported in the `certificates_security` report. */
export const APPLIANCE_LICENSE_STATES = ['valid', 'grace', 'expired', 'missing', 'invalid', 'mismatch', 'revoked'] as const;
export type ApplianceLicenseState = (typeof APPLIANCE_LICENSE_STATES)[number];
export const APPLIANCE_LICENSE_STATE_LABELS: Record<ApplianceLicenseState, string> = {
  valid: 'Valid', grace: 'Grace period', expired: 'Expired', missing: 'No license token', invalid: 'Invalid token', mismatch: 'Token for another appliance', revoked: 'Revoked by the provider',
};
export const applianceLicenseStatusSchema = z.strictObject({
  state: z.enum(APPLIANCE_LICENSE_STATES),
  licenseCode: z.string().regex(/^LIC-\d{5,}$/).nullable(),
  keyId: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
  /** Where the verification key came from: pinned in the image, or shipped in the package (images built without a key). */
  keySource: z.enum(['image', 'package', 'none']),
  tokenExpiresAt: iso.nullable(),
  licenseEndsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  verifiedAt: iso,
  /** Whether PSA work (connection tests, synchronization) is allowed under this state. */
  psaWorkAllowed: z.boolean(),
  detail: z.string().max(300),
});
export type ApplianceLicenseStatus = z.infer<typeof applianceLicenseStatusSchema>;

// base64url without Node's Buffer: the contracts run in the browser as well as on the server.
const b64url = {
  encode(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  },
};

/** Assembles a token from the claims and the Ed25519 signature over `signedBytesFor(claims)`. */
export function encodeLicenseToken(claims: LicenseTokenClaims, signature: Uint8Array): string {
  return `${LICENSE_TOKEN_PREFIX}${claimsSegment(claims)}.${b64url.encode(signature)}`;
}

/** The exact bytes a signer signs and a verifier checks: the base64url claim segment as ASCII. */
export function claimsSegment(claims: LicenseTokenClaims): string {
  return b64url.encode(new TextEncoder().encode(JSON.stringify(claims)));
}

export interface DecodedLicenseToken {
  claims: LicenseTokenClaims;
  /** ASCII bytes of the claim segment (what the signature covers). */
  signedBytes: Uint8Array;
  signature: Uint8Array;
}

/** Splits and validates a token's structure (not its signature). Throws on malformed input. */
export function decodeLicenseToken(token: string): DecodedLicenseToken {
  if (!token.startsWith(LICENSE_TOKEN_PREFIX)) throw new Error('not a license token');
  const rest = token.slice(LICENSE_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) throw new Error('malformed license token');
  const segment = rest.slice(0, dot);
  const signature = b64url.decode(rest.slice(dot + 1));
  if (signature.length !== 64) throw new Error('malformed license token signature');
  const claims = licenseTokenClaimsSchema.parse(JSON.parse(new TextDecoder().decode(b64url.decode(segment))));
  return { claims, signedBytes: new TextEncoder().encode(segment), signature };
}

/** The heartbeat / enrollment answer about licensing (next to the signed token itself). */
export const LICENSE_RENEWAL_STATES = ['active', 'inactive', 'none'] as const;
export type LicenseRenewalState = (typeof LICENSE_RENEWAL_STATES)[number];
export interface LicenseRenewal {
  /** `active`: a fresh token is attached; `inactive`: the license is suspended / expired / revoked, or the deployment is suspended; `none`: no license is bound. */
  state: LicenseRenewalState;
  token: string | null;
  licenseCode: string | null;
  reason: string | null;
}

/** Public verification key, as shown in Settings and embedded into appliance images at build time. */
export interface LicenseSigningKeyInfo {
  keyId: string;
  publicKeyPem: string;
  /** base64 of the SPKI DER — the value passed to the edge image build (`LICENSE_PUBLIC_KEY`). */
  publicKeySpkiBase64: string;
  tokenTtlDays: number;
  graceDays: number;
}
