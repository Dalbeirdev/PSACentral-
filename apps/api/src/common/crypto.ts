import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function hmacSha256(key: Buffer, input: string): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * AES-256-GCM envelope for secrets at rest: `v1.<iv>.<tag>.<ciphertext>` (base64url parts).
 * The version prefix allows key rotation; associated data binds a ciphertext to its purpose
 * (e.g. "mfa:<userId>") so it cannot be swapped onto another row.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
  }

  seal(plaintext: string, associatedData: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(associatedData));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  /** Binary payloads (e.g. package archives) are sealed as base64 text. */
  sealBytes(data: Buffer, associatedData: string): string {
    return this.seal(data.toString('base64'), associatedData);
  }

  openBytes(envelope: string, associatedData: string): Buffer {
    return Buffer.from(this.open(envelope, associatedData), 'base64');
  }

  open(envelope: string, associatedData: string): string {
    const [version, iv, tag, ct] = envelope.split('.');
    if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported secret envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
