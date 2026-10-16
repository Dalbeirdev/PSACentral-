import { describe, expect, it } from 'vitest';
import { SecretBox, safeEqual } from '../../src/common/crypto.js';
import { maskSecrets } from '../../src/common/logger.js';
import { generateTemporaryPassword, hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from '../../src/modules/auth/totp.js';

// RFC 6238 Appendix B test vectors (SHA-1, 8 digits, seed "12345678901234567890").
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  it.each(RFC_VECTORS)('matches the RFC 6238 vector at T=%i', (seconds, expected) => {
    expect(totp(RFC_SECRET, seconds * 1000, { digits: 8 })).toBe(expected);
  });

  it('matches RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, BigInt(counter))).toBe(code));
  });

  it('accepts ±1 step, rejects ±2 steps, and returns the matched step', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 60_000), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
  });

  it('round-trips base32 and builds a standards-compliant otpauth URI', () => {
    const buf = Buffer.from('hello world, totp!');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'a@b.test', 'PSA Control Center');
    expect(uri).toMatch(/^otpauth:\/\/totp\/PSA%20Control%20Center%3Aa%40b\.test\?/);
    expect(new URL(uri).searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('generates unique recovery codes and hashes them case/format-insensitively', () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(hashRecoveryCode('ABCD-efgh-2345').equals(hashRecoveryCode('abcdefgh2345'))).toBe(true);
    expect(hashRecoveryCode('abcd-efgh-2345').equals(hashRecoveryCode('abcd-efgh-2346'))).toBe(false);
  });
});

describe('password hashing (scrypt)', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$[\w-]{43}\$[\w-]{86}$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl3', hash)).toBe(false);
  });

  it('uses a unique salt per hash', async () => {
    expect(await hashPassword('same-password-123')).not.toBe(await hashPassword('same-password-123'));
  });

  it('rejects malformed or abusive encodings without throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$aaaa$bbbb')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$10$abc')).toBe(false);
  });

  it('generates policy-compliant temporary passwords', () => {
    const p = generateTemporaryPassword();
    expect(p).toMatch(/^[A-Za-z2-9]{6}(-[A-Za-z2-9]{6}){3}$/);
    expect(p).not.toBe(generateTemporaryPassword());
  });
});

describe('SecretBox (AES-256-GCM envelope)', () => {
  const box = new SecretBox(Buffer.alloc(32, 7));

  it('round-trips and never contains the plaintext', () => {
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'mfa:user-1');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed, 'mfa:user-1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('fails when the ciphertext is bound to a different row (associated data)', () => {
    const sealed = box.seal('secret', 'mfa:user-1');
    expect(() => box.open(sealed, 'mfa:user-2')).toThrow();
  });

  it('fails on tampering and with a different key', () => {
    const sealed = box.seal('secret', 'ad');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered!').toString('base64url');
    expect(() => box.open(parts.join('.'), 'ad')).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed, 'ad')).toThrow();
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow();
  });

  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('log secret masking', () => {
  it('redacts sensitive keys recursively and connection-string passwords', () => {
    const masked = maskSecrets({
      user: 'a',
      password: 'p',
      nested: { apiKey: 'k', token_hash: 'h', list: [{ secret: 's', ok: 1 }] },
      authorization: 'Bearer abc.def',
      msg: 'connecting to postgres://psacc_app:hunter2@db:5432/x',
    }) as Record<string, unknown>;
    expect(JSON.stringify(masked)).not.toMatch(/hunter2|"p"|"k"|"h"|"s"|abc\.def/);
    expect(masked.user).toBe('a');
    expect((masked.nested as { list: { ok: number }[] }).list[0]!.ok).toBe(1);
    expect(masked.msg).toBe('connecting to postgres://psacc_app:[REDACTED]@db:5432/x');
  });
});
