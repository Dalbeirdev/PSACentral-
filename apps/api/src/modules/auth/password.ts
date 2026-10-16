import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

/** scrypt parameters (OWASP Password Storage Cheat Sheet: N=2^17, r=8, p=1). */
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, keyLength: 64, saltLength: 32 } as const;
const maxmem = 256 * 1024 * 1024;

export async function hashPassword(password: string, params: { N: number; r: number; p: number } = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keyLength, { ...params, maxmem });
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every((x) => Number.isInteger(x) && x > 0) || N > 2 ** 20) return false;
  const expected = Buffer.from(keyB64!, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64!, 'base64url'), expected.length, { N, r: R, p: P, maxmem });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;
/** Spends the same work as a real verification so unknown accounts are not revealed by timing. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('psacc-timing-equalizer-not-a-real-password');
  await verifyPassword(password, await dummyHash);
}

/** Readable, policy-compliant temporary password (~120 bits). */
export function generateTemporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `${out.slice(0, 6)}-${out.slice(6, 12)}-${out.slice(12, 18)}-${out.slice(18, 24)}`;
}
