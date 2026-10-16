import { createHash, webcrypto } from 'node:crypto';
import type { webcrypto as WebCrypto } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as x509 from '@peculiar/x509';
import { unzipSync } from 'fflate';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { ensureTestLicense } from './agent-helpers.js';
import { type Client, EMAIL, ORIGIN, asApp, asAppCommit, ids, signedIn, startApp } from './helpers.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

let app: NestExpressApplication;
let port = 0;
let ops: Client;

beforeAll(async () => {
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '60' });
  const gw = app.get(AgentGateway);
  await gw.start(0, '127.0.0.1');
  port = gw.address!.port;
  ops = await signedIn(app, EMAIL.ops);
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

interface Enrollment { token: string; deploymentId: string; installationId: string; caCertificate: string; caFingerprint: string; deploymentCode: string }
interface Agent { keyPem: string; certPem?: string }

async function inOrgA<T>(fn: (c: import('pg').Client) => Promise<T>) {
  const { orgA } = await ids();
  return asApp({ orgId: orgA, scopeAll: true }, fn);
}

/** A real package for a fresh deployment, and the enrollment file inside it. */
async function packageFor(clientCode = 'CL-00014'): Promise<Enrollment & { packageId: string }> {
  const clientId = await inOrgA(async (c) => (await c.query('SELECT id FROM clients WHERE code = $1', [clientCode])).rows[0].id as string);
  const psa = await inOrgA(async (c) => (await c.query(`SELECT id FROM psa_instances WHERE client_id = $1 AND status = 'active' ORDER BY code LIMIT 1`, [clientId])).rows[0].id as string);
  await ensureTestLicense(ops, clientId);
  const dep = (await ops.post('/deployments', { clientId, psaInstanceId: psa, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' })).body;
  const pkg = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
  const res = await supertest(app.getHttpServer()).post(`/api/v1/deployments/${dep.id}/packages/${pkg.id}/download`)
    .set('cookie', ops.cookieHeader).set('origin', ORIGIN).set('x-csrf-token', ops.cookies.get('psacc_csrf') ?? '').buffer(true)
    .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
  const files = unzipSync(new Uint8Array(res.body as Buffer));
  const en = JSON.parse(Buffer.from(files[`psacc-${dep.code.toLowerCase()}/enrollment/enrollment.json`]!).toString());
  return { ...en, packageId: pkg.id };
}

async function keyAndCsr(cn: string): Promise<{ keyPem: string; csr: string }> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as WebCrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${cn}`, keys: keys as never, signingAlgorithm: ALG });
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { keyPem: `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`, csr: csr.toString('pem') };
}

/** HTTPS to the gateway, verifying its certificate against the pinned CA; optionally with a client certificate. */
function gw(path: string, body: unknown, ca: string, agent?: Agent, method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, path, method, ca, rejectUnauthorized: true, key: agent?.certPem ? agent.keyPem : undefined, cert: agent?.certPem, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function enroll(en: Enrollment, over: Record<string, unknown> = {}) {
  const k = await keyAndCsr((over.cn as string) ?? en.installationId);
  const r = await gw('/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: k.csr, agentVersion: '0.1.0', ...over, cn: undefined }, en.caCertificate);
  return { ...r, agent: { keyPem: k.keyPem, certPem: r.body.certificate as string | undefined } };
}
/** Enrollment that must succeed. */
async function enrolled(en: Enrollment) {
  const r = await enroll(en);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r;
}

describe('agent gateway: enrollment with the single-use token', () => {
  it('packages pin the platform CA, and the gateway presents a certificate that chains to it', async () => {
    const en = await packageFor();
    const stored = await asApp(null, async (c) => (await c.query('SELECT ca_cert_pem, ca_fingerprint FROM pki_authorities')).rows[0]);
    expect(en.caCertificate).toBe(stored.ca_cert_pem);
    expect(en.caFingerprint).toBe(stored.ca_fingerprint);
    expect((await gw('/agent/v1/health', undefined, en.caCertificate, undefined, 'GET')).body).toEqual({ status: 'ok' });
    await expect(gw('/agent/v1/health', undefined, '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUBogus\n-----END CERTIFICATE-----\n', undefined, 'GET')).rejects.toThrow();
  });

  it('refuses unknown, malformed and mismatched requests, and audits rejections of a known token', async () => {
    const en = await packageFor();
    expect((await enroll(en, { token: 'psacc_enr_' + 'x'.repeat(43) })).body).toMatchObject({ error: 'invalid-token' });
    expect((await gw('/agent/v1/enroll', { token: en.token }, en.caCertificate)).status).toBe(400);
    const wrongInstallation = await enroll(en, { installationId: '00000000-0000-4000-8000-000000000000', cn: '00000000-0000-4000-8000-000000000000' });
    expect(wrongInstallation).toMatchObject({ status: 403, body: { error: 'identity-mismatch' } });
    expect((await enroll(en, { cn: 'someone-else' })).body).toMatchObject({ error: 'csr-subject' });
    expect((await enroll(en, { csr: '-----BEGIN CERTIFICATE REQUEST-----\nnot-a-csr-at-all-but-long-enough-to-pass-the-length-check-of-one-hundred-characters-xx\n-----END CERTIFICATE REQUEST-----' })).body).toMatchObject({ error: 'invalid-csr' });
    const audit = await inOrgA(async (c) => (await c.query(`SELECT metadata->>'reason' AS reason, outcome FROM audit_events WHERE action = 'agent.enrollment.rejected' AND target_id = $1`, [en.deploymentId])).rows);
    expect(audit).toEqual([{ reason: 'identity-mismatch', outcome: 'denied' }]);
    // None of this consumed the token.
    expect((await enroll(en)).status).toBe(201);
  });

  it('issues a client certificate, consumes the token, registers the installation and marks the deployment enrolled', async () => {
    const en = await packageFor();
    const r = await enroll(en);
    expect(r.status).toBe(201);
    const cert = new x509.X509Certificate(r.body.certificate as string);
    const ca = new x509.X509Certificate(en.caCertificate);
    expect(await cert.verify({ publicKey: ca.publicKey, signatureOnly: true })).toBe(true);
    expect(cert.subjectName.getField('CN')[0]).toBe(en.installationId);
    expect(cert.getExtension(x509.ExtendedKeyUsageExtension)!.usages).toEqual([x509.ExtendedKeyUsage.clientAuth]);
    expect(cert.getExtension(x509.SubjectAlternativeNameExtension)!.names.items.map((n) => n.value)).toEqual([`urn:psacc:deployment:${en.deploymentId}`, `urn:psacc:installation:${en.installationId}`]);
    expect((cert.notAfter.getTime() - Date.now()) / 86_400_000).toBeGreaterThan(89);

    const d = (await ops.get(`/deployments/${en.deploymentId}`)).body;
    expect(d).toMatchObject({ lifecycleState: 'enrolled', installationId: en.installationId, agentVersion: '0.1.0' });
    expect(d.enrolledAt).not.toBeNull();
    expect(d.packages[0]).toMatchObject({ status: 'consumed', downloadable: false, token: { status: 'consumed' } });
    expect(d.agentCertificates).toHaveLength(1);
    expect(d.agentCertificates[0]).toMatchObject({ status: 'active', issuedVia: 'enrollment', fingerprint: createHash('sha256').update(Buffer.from(cert.rawData)).digest('hex') });
    expect((await ops.get(`/deployments/${en.deploymentId}/activity`)).body.items[0]).toMatchObject({ action: 'agent.enrolled', actorType: 'agent' });
    // Single use: the same token never works twice.
    expect(await enroll(en)).toMatchObject({ status: 409, body: { error: 'token-used' } });
  });

  it('two concurrent enrollments with one token: exactly one certificate is issued', async () => {
    const en = await packageFor();
    const results = await Promise.all([enroll(en), enroll(en), enroll(en)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const count = await inOrgA(async (c) => (await c.query('SELECT count(*)::int AS n FROM agent_certificates WHERE deployment_id = $1', [en.deploymentId])).rows[0].n);
    expect(count).toBe(1);
  });

  it('expired and revoked tokens are refused', async () => {
    const expired = await packageFor();
    const { orgA } = await ids();
    await asAppCommit({ orgId: orgA }, (c) => c.query(`UPDATE enrollment_tokens SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE package_id = $1`, [expired.packageId]));
    expect((await enroll(expired)).body).toMatchObject({ error: 'token-expired' });
    const revoked = await packageFor();
    await ops.post(`/deployments/${revoked.deploymentId}/packages/${revoked.packageId}/revoke`, { reason: 'Test revocation' });
    expect((await enroll(revoked)).body).toMatchObject({ error: 'token-revoked' });
  });
});

describe('agent gateway: certificate-authenticated communication', () => {
  it('heartbeats need a platform-issued certificate and update the deployment', async () => {
    const en = await packageFor();
    const { agent } = await enrolled(en);
    const hb = { agentVersion: '0.1.1', observedAt: new Date().toISOString() };
    expect(await gw('/agent/v1/heartbeat', hb, en.caCertificate)).toMatchObject({ status: 401, body: { error: 'certificate-required' } });
    // A self-signed certificate (not from the platform CA) is not accepted either.
    const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as WebCrypto.CryptoKeyPair;
    const rogue = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name: `CN=${en.installationId}`, notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000), signingAlgorithm: ALG, keys: keys as never });
    const rogueKey = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    expect((await gw('/agent/v1/heartbeat', hb, en.caCertificate, { keyPem: `-----BEGIN PRIVATE KEY-----\n${rogueKey}\n-----END PRIVATE KEY-----\n`, certPem: rogue.toString('pem') })).body).toMatchObject({ error: 'certificate-required' });

    const before = (await ops.get(`/deployments/${en.deploymentId}`)).body.lastHeartbeatAt;
    await new Promise((r) => setTimeout(r, 20));
    const ok = await gw('/agent/v1/heartbeat', hb, en.caCertificate, agent);
    expect(ok).toMatchObject({ status: 200, body: { status: 'ok' } });
    const d = (await ops.get(`/deployments/${en.deploymentId}`)).body;
    expect(new Date(d.lastHeartbeatAt).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(d).toMatchObject({ agentVersion: '0.1.1', healthState: 'unknown' }); // health rules arrive in Module 8
    expect((await gw('/agent/v1/heartbeat', { ...hb, extra: 'ticket content' }, en.caCertificate, agent)).status).toBe(400); // allow-listed fields only
  });

  it('renewal issues a new certificate and retires the old one', async () => {
    const en = await packageFor();
    const { agent } = await enrolled(en);
    const k = await keyAndCsr(en.installationId);
    const r = await gw('/agent/v1/renew', { csr: k.csr }, en.caCertificate, agent);
    expect(r.status).toBe(200);
    const renewed = { keyPem: k.keyPem, certPem: r.body.certificate as string };
    const hb = { agentVersion: '0.1.0', observedAt: new Date().toISOString() };
    expect(await gw('/agent/v1/heartbeat', hb, en.caCertificate, agent)).toMatchObject({ status: 403, body: { error: 'superseded' } });
    expect((await gw('/agent/v1/heartbeat', hb, en.caCertificate, renewed)).status).toBe(200);
    const certs = (await ops.get(`/deployments/${en.deploymentId}`)).body.agentCertificates;
    expect(certs.map((c: { status: string; issuedVia: string }) => `${c.issuedVia}:${c.status}`)).toEqual(['renewal:active', 'enrollment:superseded']);
    // A renewal CSR must still name the same installation.
    const other = await keyAndCsr('another-installation');
    expect((await gw('/agent/v1/renew', { csr: other.csr }, en.caCertificate, renewed)).body).toMatchObject({ error: 'csr-subject' });
  });

  it('revocation is immediate, and the deployment can re-enroll only with a new package', async () => {
    const en = await packageFor();
    const { agent } = await enrolled(en);
    const viewer = await signedIn(app, EMAIL.viewer);
    expect((await viewer.post(`/deployments/${en.deploymentId}/agent-certificate/revoke`, { reason: 'not allowed' })).status).toBe(403);
    const r = await ops.post(`/deployments/${en.deploymentId}/agent-certificate/revoke`, { reason: 'Host decommissioned by the client' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ lifecycleState: 'draft', installationId: null });
    expect(r.body.agentCertificates[0]).toMatchObject({ status: 'revoked', revokeReason: 'Host decommissioned by the client' });
    const hb = { agentVersion: '0.1.0', observedAt: new Date().toISOString() };
    expect(await gw('/agent/v1/heartbeat', hb, en.caCertificate, agent)).toMatchObject({ status: 403, body: { error: 'revoked' } });
    expect((await ops.post(`/deployments/${en.deploymentId}/agent-certificate/revoke`, { reason: 'again' })).status).toBe(409);
    // A new package means a new installation identity and token; the old token stays used.
    const next = await ops.post(`/deployments/${en.deploymentId}/packages`, { tokenValidityHours: 1 });
    expect(next.status).toBe(201);
    expect(next.body.currentPackage.installationId).not.toBe(en.installationId);
  });

  it('organization B cannot see another organization’s agent certificates; the table fails closed', async () => {
    const en = await packageFor();
    await enrolled(en);
    const b = await signedIn(app, EMAIL.orgB);
    expect((await b.get(`/deployments/${en.deploymentId}`)).status).toBe(404);
    expect((await b.post(`/deployments/${en.deploymentId}/agent-certificate/revoke`, { reason: 'cross tenant' })).status).toBe(404);
    expect(await asApp(null, async (c) => (await c.query('SELECT count(*)::int AS n FROM agent_certificates')).rows[0].n)).toBe(0);
  });

  it('authenticated agents are rate limited per certificate identity, not per address (fleets behind NAT)', async () => {
    // Two agents from the same address: the per-identity limit applies to each; the address limit does not.
    const enA = await packageFor();
    const enB = await packageFor();
    const a = (await enrolled(enA)).agent;
    const b = (await enrolled(enB)).agent;
    const hb = { agentVersion: '0.1.0', observedAt: new Date().toISOString() };
    const statusesA: number[] = [];
    for (let i = 0; i < 125; i++) statusesA.push((await gw('/agent/v1/heartbeat', hb, enA.caCertificate, a)).status);
    expect(statusesA.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statusesA.slice(120)).toContain(429);
    expect((await gw('/agent/v1/heartbeat', hb, enB.caCertificate, b)).status).toBe(200); // b is unaffected by a's burst
    // Without a certificate, the address limit applies.
    const anon: number[] = [];
    for (let i = 0; i < 65; i++) anon.push((await gw('/agent/v1/heartbeat', hb, enA.caCertificate)).status);
    expect(anon).toContain(401);
    expect(anon).toContain(429);
  });

  it('enrollment attempts are rate limited per address', async () => {
    const en = await packageFor();
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await gw('/agent/v1/enroll', { token: 'bad' }, en.caCertificate)).status);
    expect(statuses).toContain(429);
  });

});
