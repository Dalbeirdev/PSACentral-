import { createHash, randomBytes, webcrypto } from 'node:crypto';
import type { webcrypto as WebCrypto } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { SecretBox } from '../../common/crypto.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const subtle = webcrypto.subtle;
const DAY = 86_400_000;

export interface GatewayTls {
  caPem: string;
  caFingerprint: string;
  serverCertPem: string;
  serverKeyPem: string;
  names: string[];
}

export interface IssuedCertificate {
  pem: string;
  serial: string;
  fingerprint: Buffer;
  subject: string;
  notBefore: Date;
  notAfter: Date;
}

export class CsrRejected extends Error {
  constructor(public readonly code: 'invalid-csr' | 'csr-signature' | 'csr-key' | 'csr-subject', message: string) {
    super(message);
  }
}

/** Positive 128-bit serial as 32 hex characters. */
function serial(): string {
  const b = randomBytes(16);
  b[0] = b[0]! & 0x7f;
  return b.toString('hex');
}

function pemKey(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END PRIVATE KEY-----\n`;
}

function derFromPem(pem: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'));
}

export const fingerprintOf = (der: ArrayBuffer | Buffer) => createHash('sha256').update(Buffer.from(der as ArrayBuffer)).digest();

/**
 * The platform's internal PKI: a CA that signs agent machine certificates, and the agent gateway's
 * TLS server certificate. Created on first use; private keys are stored encrypted with the
 * application data key (SEC-KMS will move them to a KMS).
 */
@Injectable()
export class PkiService {
  private readonly box: SecretBox;
  private cached: { tls: GatewayTls; caCert: x509.X509Certificate; caKey: WebCrypto.CryptoKey } | null = null;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox(config.secrets.dataEncryptionKey);
  }

  private async newServerCert(caCert: x509.X509Certificate, caKey: WebCrypto.CryptoKey, names: string[]) {
    const keys = (await subtle.generateKey(ALG, true, ['sign', 'verify'])) as WebCrypto.CryptoKeyPair;
    const now = Date.now();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: 'CN=PSA Control Center agent gateway',
      issuer: caCert.subject,
      notBefore: new Date(now - 5 * 60_000),
      notAfter: new Date(now + 397 * DAY),
      signingAlgorithm: ALG,
      publicKey: keys.publicKey,
      signingKey: caKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true),
        new x509.SubjectAlternativeNameExtension(names.map((n) => (isIP(n) ? { type: 'ip' as const, value: n } : { type: 'dns' as const, value: n }))),
        await x509.AuthorityKeyIdentifierExtension.create(caCert, false),
      ],
    });
    return { pem: cert.toString('pem'), keyPem: pemKey(await subtle.exportKey('pkcs8', keys.privateKey)) };
  }

  /** Loads the CA and gateway certificate, creating them on first use (and reissuing the server certificate when its names change). */
  async ensure(): Promise<GatewayTls> {
    const names = this.config.gateway.names;
    if (this.cached && names.every((n) => this.cached!.tls.names.includes(n))) return this.cached.tls;
    let row = await this.db.unscoped((q) => q.maybeOne<Record<string, unknown>>('SELECT * FROM pki_authorities WHERE id = 1'));
    if (!row) {
      const keys = (await subtle.generateKey(ALG, true, ['sign', 'verify'])) as WebCrypto.CryptoKeyPair;
      const now = Date.now();
      const ca = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: serial(),
        name: 'CN=PSA Control Center Agent CA, O=PSA Control Center',
        notBefore: new Date(now - 5 * 60_000),
        notAfter: new Date(now + 3650 * DAY),
        signingAlgorithm: ALG,
        keys,
        extensions: [
          new x509.BasicConstraintsExtension(true, 0, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
          await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        ],
      });
      const server = await this.newServerCert(ca, keys.privateKey, names);
      const caKeyPem = pemKey(await subtle.exportKey('pkcs8', keys.privateKey));
      await this.db.unscoped((q) =>
        q.query(
          `INSERT INTO pki_authorities (id, ca_cert_pem, ca_key_ciphertext, ca_fingerprint, server_cert_pem, server_key_ciphertext, server_names)
           VALUES (1, $1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          [ca.toString('pem'), this.box.seal(caKeyPem, 'pki:ca'), fingerprintOf(ca.rawData).toString('hex'), server.pem, this.box.seal(server.keyPem, 'pki:gateway'), names],
        ),
      );
      row = await this.db.unscoped((q) => q.one<Record<string, unknown>>('SELECT * FROM pki_authorities WHERE id = 1'));
    }
    const caCert = new x509.X509Certificate(row.ca_cert_pem as string);
    const caKey = await subtle.importKey('pkcs8', derFromPem(this.box.open(row.ca_key_ciphertext as string, 'pki:ca')), ALG, false, ['sign']);
    let serverCertPem = row.server_cert_pem as string;
    let serverKeyPem = this.box.open(row.server_key_ciphertext as string, 'pki:gateway');
    let stored = row.server_names as string[];
    if (!names.every((n) => stored.includes(n))) {
      stored = [...new Set([...stored, ...names])];
      const server = await this.newServerCert(caCert, caKey, stored);
      serverCertPem = server.pem;
      serverKeyPem = server.keyPem;
      await this.db.unscoped((q) =>
        q.query(`UPDATE pki_authorities SET server_cert_pem = $1, server_key_ciphertext = $2, server_names = $3, server_rotated_at = now() WHERE id = 1`, [
          serverCertPem, this.box.seal(serverKeyPem, 'pki:gateway'), stored,
        ]),
      );
    }
    const tls = { caPem: caCert.toString('pem'), caFingerprint: row.ca_fingerprint as string, serverCertPem, serverKeyPem, names: stored };
    this.cached = { tls, caCert, caKey };
    return tls;
  }

  /**
   * Issues a client certificate for an agent from its CSR. The CSR must prove possession of the key,
   * use ECDSA P-256, and name the installation (CN = installation ID).
   */
  async issueAgentCertificate(csrPem: string, ids: { deploymentId: string; deploymentCode: string; installationId: string }): Promise<IssuedCertificate> {
    await this.ensure();
    const { caCert, caKey } = this.cached!;
    let csr: x509.Pkcs10CertificateRequest;
    try {
      if (csrPem.length > 8192) throw new Error('too long');
      csr = new x509.Pkcs10CertificateRequest(csrPem);
    } catch {
      throw new CsrRejected('invalid-csr', 'The certificate request could not be read.');
    }
    if (!(await csr.verify())) throw new CsrRejected('csr-signature', 'The certificate request signature is not valid.');
    const alg = csr.publicKey.algorithm as WebCrypto.EcKeyAlgorithm;
    if (alg.name !== 'ECDSA' || alg.namedCurve !== 'P-256') throw new CsrRejected('csr-key', 'The agent key must be ECDSA P-256.');
    const cn = csr.subjectName.getField('CN')[0];
    if (cn !== ids.installationId) throw new CsrRejected('csr-subject', 'The certificate request must name this installation.');
    const now = Date.now();
    const notBefore = new Date(now - 5 * 60_000);
    const notAfter = new Date(now + this.config.gateway.certificateDays * DAY);
    const subject = `CN=${ids.installationId}, OU=${ids.deploymentCode}, O=PSA Control Center Agent`;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject,
      issuer: caCert.subject,
      notBefore,
      notAfter,
      signingAlgorithm: ALG,
      publicKey: await csr.publicKey.export(),
      signingKey: caKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
        new x509.SubjectAlternativeNameExtension([
          { type: 'url', value: `urn:psacc:deployment:${ids.deploymentId}` },
          { type: 'url', value: `urn:psacc:installation:${ids.installationId}` },
        ]),
        await x509.AuthorityKeyIdentifierExtension.create(caCert, false),
      ],
    });
    return { pem: cert.toString('pem'), serial: cert.serialNumber.toLowerCase().padStart(32, '0'), fingerprint: fingerprintOf(cert.rawData), subject, notBefore, notAfter };
  }
}
