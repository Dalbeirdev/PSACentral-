import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual, sha256 } from '../../common/crypto.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

/** RFC 4226 HOTP. */
export function hotp(secret: Buffer, counter: bigint, digits = 6, algorithm: TotpOptions['algorithm'] = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm!, secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/** RFC 6238 TOTP for the time step containing `atMs`. */
export function totp(secret: Buffer, atMs: number, opts: TotpOptions = {}): string {
  const period = opts.period ?? 30;
  return hotp(secret, BigInt(Math.floor(atMs / 1000 / period)), opts.digits ?? 6, opts.algorithm ?? 'sha1');
}

/**
 * Verifies a code within ±window steps. Returns the matched time step, or null.
 * Callers must reject steps <= the last accepted step (replay protection).
 */
export function verifyTotp(secret: Buffer, code: string, atMs: number, window = 1, period = 30): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(atMs / 1000 / period);
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    if (safeEqual(hotp(secret, BigInt(step)), code)) return step;
  }
  return null;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUri(secretB32: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Recovery codes look like `k7m2-x9qp-4tdr`; stored only as SHA-256 of the normalized form. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashRecoveryCode(code: string): Buffer {
  return sha256(`psacc-recovery:${normalizeRecoveryCode(code)}`);
}
