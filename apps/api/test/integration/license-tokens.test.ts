import type { NestExpressApplication } from '@nestjs/platform-express';
import { type LicenseRenewal, type LicenseSigningKeyInfo, decodeLicenseToken } from '@psacc/contracts';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { LicenseTokensService } from '../../src/modules/deployments/license-tokens.service.js';
import { type AgentIdentity, enrolledAgent, gw, healthyReports, packageFor } from './agent-helpers.js';
import { generateKeyPairSync } from 'node:crypto';
import supertest from 'supertest';
import { type Client, EMAIL, ORIGIN, signedIn, startApp } from './helpers.js';

/**
 * Module 16 — Offline-verifiable license tokens. The package carries a signed token bound to its
 * installation; enrollment and every heartbeat renew it while the license is active; suspended, expired
 * or revoked licenses (and suspended deployments) answer `inactive`; the public verification key is
 * published for image builds; the appliance's own verdict is reported back and shows in health.
 */
let app: NestExpressApplication;
let port: number;
let ops: Client;
let admin: Client;
let viewer: Client;
let keyInfo: LicenseSigningKeyInfo;

const heartbeat = (a: AgentIdentity) => gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a);
const licenseOf = (dep: Record<string, unknown>) => (dep.licenseDetail as { id: string; code: string }) ?? null;

beforeAll(async () => {
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '100' });
  const g = app.get(AgentGateway);
  await g.start(0, '127.0.0.1');
  port = g.address!.port;
  ops = await signedIn(app, EMAIL.ops);
  admin = await signedIn(app, EMAIL.admin);
  viewer = await signedIn(app, EMAIL.viewer);
  keyInfo = (await admin.get('/settings/licensing-key')).body as LicenseSigningKeyInfo;
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

describe('license tokens', () => {
  it('publishes the verification key for image builds (settings.read) and the token policy', async () => {
    expect(keyInfo.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(keyInfo.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(Buffer.from(keyInfo.publicKeySpkiBase64, 'base64').length).toBe(44); // Ed25519 SPKI DER
    expect(keyInfo).toMatchObject({ tokenTtlDays: 30, graceDays: 14 });
    expect((await viewer.get('/settings/licensing-key')).status).toBe(403); // Read Only holds no settings.read
    // The key is derived from the LICENSE_SIGNING_KEY secret: deterministic across restarts.
    expect(app.get(LicenseTokensService).info.keyId).toBe(keyInfo.keyId);
  });

  it('ships a signed token in the package, bound to the deployment and the package installation', async () => {
    const en = await packageFor(app, ops);
    const dep = (await ops.get(`/deployments/${en.deploymentId}`)).body;
    const res = await supertest(app.getHttpServer()).post(`/api/v1/deployments/${en.deploymentId}/packages/${en.packageId}/download`)
      .set('cookie', ops.cookieHeader).set('origin', ORIGIN).set('x-csrf-token', ops.cookies.get('psacc_csrf') ?? '').buffer(true)
      .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    const zip = res.body as Buffer;
    const files = unzipSync(new Uint8Array(zip));
    const lic = JSON.parse(Buffer.from(files[`psacc-${en.deploymentCode.toLowerCase()}/config/license.json`]!).toString());
    expect(lic).toMatchObject({ schemaVersion: 1, keyId: keyInfo.keyId, publicKeyPem: keyInfo.publicKeyPem });
    const claims = LicenseTokensService.verify(lic.token, keyInfo.publicKeyPem);
    expect(claims).toMatchObject({ v: 1, keyId: keyInfo.keyId, deploymentId: en.deploymentId, deploymentCode: en.deploymentCode, installationId: en.installationId, licenseCode: licenseOf(dep)!.code, graceDays: 14 });
    expect(new Date(claims!.expiresAt).getTime() - new Date(claims!.issuedAt).getTime()).toBe(30 * 86_400_000);
    // A token signed by another key, or altered, does not verify; the structure alone is not trusted.
    const otherKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }) as string;
    expect(LicenseTokensService.verify(lic.token, otherKey)).toBeNull();
    expect(LicenseTokensService.verify(`${lic.token.slice(0, -4)}AAAA`, keyInfo.publicKeyPem)).toBeNull();
    expect(decodeLicenseToken(lic.token).claims.licenseCode).toBe(licenseOf(dep)!.code);
    // The compose files mount the token file into every appliance service.
    const compose = Buffer.from(files[`psacc-${en.deploymentCode.toLowerCase()}/compose.yaml`]!).toString();
    expect((compose.match(/\/etc\/psa-edge\/license\.json:ro/g) ?? []).length).toBe(3);
  });

  it('renews the token on enrollment and on every heartbeat, bound to the enrolled installation', async () => {
    const a = await enrolledAgent(app, ops, port);
    const hb = await heartbeat(a);
    expect(hb.status).toBe(200);
    const renewal = hb.body.license as LicenseRenewal;
    expect(renewal.state).toBe('active');
    const claims = LicenseTokensService.verify(renewal.token!, keyInfo.publicKeyPem);
    expect(claims).toMatchObject({ deploymentId: a.en.deploymentId, installationId: a.en.installationId, licenseCode: renewal.licenseCode });
    // Two heartbeats: two distinct tokens (fresh issue time), both verifiable.
    const again = (await heartbeat(a)).body.license as LicenseRenewal;
    expect(again.token).not.toBe(renewal.token);
    expect(LicenseTokensService.verify(again.token!, keyInfo.publicKeyPem)).not.toBeNull();
  });

  it('answers inactive (no token) while the license is suspended, expired or revoked, or the deployment is suspended; active again afterwards', async () => {
    const a = await enrolledAgent(app, ops, port);
    const dep = (await ops.get(`/deployments/${a.en.deploymentId}`)).body;
    const lic = licenseOf(dep)!;
    expect(((await heartbeat(a)).body.license as LicenseRenewal).state).toBe('active');
    // Suspend the license.
    expect((await ops.post(`/licenses/${lic.id}/suspend`, { reason: 'Invoice overdue' })).status).toBe(200);
    let r = (await heartbeat(a)).body.license as LicenseRenewal;
    expect(r).toMatchObject({ state: 'inactive', token: null, licenseCode: lic.code });
    expect(r.reason).toMatch(/suspended/);
    expect((await ops.post(`/licenses/${lic.id}/resume`, { reason: 'Paid' })).status).toBe(200);
    expect(((await heartbeat(a)).body.license as LicenseRenewal).state).toBe('active');
    // Suspend the deployment itself.
    expect((await ops.post(`/deployments/${a.en.deploymentId}/suspend`, { reason: 'Paused' })).status).toBe(200);
    r = (await heartbeat(a)).body.license as LicenseRenewal;
    expect(r).toMatchObject({ state: 'inactive', token: null });
    expect(r.reason).toMatch(/deployment is suspended/);
    expect((await ops.post(`/deployments/${a.en.deploymentId}/resume`, { reason: 'Back' })).status).toBe(200);
    expect(((await heartbeat(a)).body.license as LicenseRenewal).state).toBe('active');
    // Let the license term end (today's date is past the end): inactive with the end date.
    const detail = (await ops.get(`/licenses/${lic.id}`)).body;
    const ended = await ops.patch(`/licenses/${lic.id}`, { version: detail.version, displayName: detail.displayName, startsAt: '2026-01-01', endsAt: '2026-01-31', maxDeployments: detail.maxDeployments, notes: detail.notes ?? '' });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    r = (await heartbeat(a)).body.license as LicenseRenewal;
    expect(r.state).toBe('inactive');
    expect(r.reason).toMatch(/ended on 2026-01-31|is expired/);
  });

  it('shows the appliance verdict in the deployment detail and in health findings', async () => {
    const a = await enrolledAgent(app, ops, port);
    const verdict = (state: string, allowed: boolean, detail: string) => ({ state, licenseCode: 'LIC-00001', keyId: keyInfo.keyId, keySource: 'image', tokenExpiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), licenseEndsAt: null, verifiedAt: new Date().toISOString(), psaWorkAllowed: allowed, detail });
    expect((await gw(port, '/agent/v1/reports', healthyReports({ certificates_security: { license: verdict('valid', true, 'ok') } }), a.en.caCertificate, a)).status).toBe(200);
    let dep = (await ops.get(`/deployments/${a.en.deploymentId}`)).body;
    expect(dep.applianceLicense).toMatchObject({ state: 'valid', keySource: 'image', psaWorkAllowed: true });
    expect((await ops.get(`/deployments/${a.en.deploymentId}/health`)).body.findings.map((f: { code: string }) => f.code)).not.toContain('appliance_license_valid');
    // The appliance says its token is invalid: degraded with the reason; grace: informational.
    expect((await gw(port, '/agent/v1/reports', healthyReports({ certificates_security: { license: verdict('invalid', false, 'The license token does not verify: signature does not verify.') } }), a.en.caCertificate, a)).status).toBe(200);
    const h = (await ops.get(`/deployments/${a.en.deploymentId}/health`)).body;
    expect(h.healthState).toBe('degraded');
    expect(h.findings.find((f: { code: string }) => f.code === 'appliance_license_invalid')).toMatchObject({ severity: 'degraded' });
    expect((await gw(port, '/agent/v1/reports', healthyReports({ certificates_security: { license: verdict('grace', true, 'renewal pending') } }), a.en.caCertificate, a)).status).toBe(200);
    dep = (await ops.get(`/deployments/${a.en.deploymentId}`)).body;
    expect(dep.applianceLicense.state).toBe('grace');
    expect((await ops.get(`/deployments/${a.en.deploymentId}/health`)).body.findings.find((f: { code: string }) => f.code === 'appliance_license_grace')).toMatchObject({ severity: 'info' });
    // A report with an unknown state is refused by the strict schema.
    const bad = await gw(port, '/agent/v1/reports', healthyReports({ certificates_security: { license: { ...verdict('valid', true, 'x'), state: 'whatever' } } }), a.en.caCertificate, a);
    expect((bad.body.rejected as { type: string }[]).map((r) => r.type)).toEqual(['certificates_security']);
    // Older agents (no license field) keep working.
    expect((await gw(port, '/agent/v1/reports', healthyReports(), a.en.caCertificate, a)).status).toBe(200);
  });
});
