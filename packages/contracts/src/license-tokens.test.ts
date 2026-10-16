import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_LICENSE_STATE_LABELS,
  APPLIANCE_LICENSE_STATES,
  applianceLicenseStatusSchema,
  claimsSegment,
  decodeLicenseToken,
  encodeLicenseToken,
  LICENSE_GRACE_DAYS,
  LICENSE_TOKEN_PREFIX,
  LICENSE_TOKEN_TTL_DAYS,
  type LicenseTokenClaims,
  licenseTokenClaimsSchema,
} from './license-tokens.js';

const claims: LicenseTokenClaims = {
  v: 1, keyId: '0123456789abcdef', licenseId: '22222222-2222-4222-8222-222222222222', licenseCode: 'LIC-00007', plan: 'Help Desk Plus',
  organizationId: '33333333-3333-4333-8333-333333333333', clientId: '55555555-5555-4555-8555-555555555555', deploymentId: '11111111-1111-4111-8111-111111111111',
  deploymentCode: 'DEP-00042', installationId: '44444444-4444-4444-8444-444444444444', issuedAt: '2026-10-16T10:00:00.000Z', expiresAt: '2026-11-15T10:00:00.000Z',
  licenseEndsAt: '2027-06-30', graceDays: 14,
};

describe('license tokens (Module 16)', () => {
  it('round-trips claims and signature through the wire format, and the signed bytes are the claim segment itself', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const segment = claimsSegment(claims);
    const signature = sign(null, Buffer.from(segment, 'ascii'), privateKey);
    const token = encodeLicenseToken(claims, new Uint8Array(signature));
    expect(token.startsWith(LICENSE_TOKEN_PREFIX)).toBe(true);
    expect(token).not.toMatch(/[+/=]/); // base64url only: safe in files and query strings
    const d = decodeLicenseToken(token);
    expect(d.claims).toEqual(claims);
    expect(Buffer.from(d.signedBytes).toString('ascii')).toBe(segment);
    expect(verify(null, Buffer.from(d.signedBytes), publicKey, Buffer.from(d.signature))).toBe(true);
    // The key object round-trips through PEM the way the API exposes it.
    expect(verify(null, Buffer.from(d.signedBytes), createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(d.signature))).toBe(true);
    expect(createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })).type).toBe('private');
  });

  it('refuses malformed tokens and invalid claims', () => {
    expect(() => decodeLicenseToken('hello')).toThrow(/not a license token/);
    expect(() => decodeLicenseToken(`${LICENSE_TOKEN_PREFIX}abc`)).toThrow(/malformed/);
    expect(() => decodeLicenseToken(`${LICENSE_TOKEN_PREFIX}${claimsSegment(claims)}.AAAA`)).toThrow(/signature/);
    const bad = { ...claims, licenseCode: 'nope' } as LicenseTokenClaims;
    expect(() => decodeLicenseToken(encodeLicenseToken(bad, new Uint8Array(64)))).toThrow();
    expect(licenseTokenClaimsSchema.safeParse({ ...claims, extra: 1 }).success).toBe(false);
    expect(licenseTokenClaimsSchema.safeParse({ ...claims, licenseEndsAt: null }).success).toBe(true);
  });

  it('describes the appliance states and the policy constants', () => {
    expect(APPLIANCE_LICENSE_STATES).toEqual(['valid', 'grace', 'expired', 'missing', 'invalid', 'mismatch', 'revoked']);
    for (const s of APPLIANCE_LICENSE_STATES) expect(APPLIANCE_LICENSE_STATE_LABELS[s].length).toBeGreaterThan(3);
    expect(LICENSE_TOKEN_TTL_DAYS).toBe(30);
    expect(LICENSE_GRACE_DAYS).toBe(14);
    const status = { state: 'valid', licenseCode: 'LIC-00007', keyId: '0123456789abcdef', keySource: 'image', tokenExpiresAt: claims.expiresAt, licenseEndsAt: '2027-06-30', verifiedAt: '2026-10-16T10:00:00Z', psaWorkAllowed: true, detail: 'ok' };
    expect(applianceLicenseStatusSchema.safeParse(status).success).toBe(true);
    expect(applianceLicenseStatusSchema.safeParse({ ...status, state: 'unknown' }).success).toBe(false);
  });
});
