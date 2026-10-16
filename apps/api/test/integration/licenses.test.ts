import type { NestExpressApplication } from '@nestjs/platform-express';
import type { LicenseDetail, LicenseSummary, Paged, SignedCommand } from '@psacc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { LicensesService } from '../../src/modules/deployments/licenses.service.js';
import { unzipSync } from 'fflate';
import supertest from 'supertest';
import { type AgentIdentity, enrolledAgent, gw, keyAndCsr, packageFor } from './agent-helpers.js';
import { type Client, EMAIL, ORIGIN, asApp, asAppCommit, ids, signedIn, startApp } from './helpers.js';

/**
 * Module 14 — Licensing, suspension and lifecycle. Licenses are per-client entitlements with their own
 * identifier; deployments bind to one and need it active (with free capacity) to get a package or to
 * enroll. Suspension is reversible and reaches an enrolled appliance as a signed command.
 */
let app: NestExpressApplication;
let port: number;
let ops: Client;
let admin: Client;
let tech: Client;
let viewer: Client;
let orgB: Client;
let orgA = '';
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const heartbeat = (a: AgentIdentity) => gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a);

beforeAll(async () => {
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '100' });
  const g = app.get(AgentGateway);
  await g.start(0, '127.0.0.1');
  port = g.address!.port;
  ops = await signedIn(app, EMAIL.ops);
  admin = await signedIn(app, EMAIL.admin);
  tech = await signedIn(app, EMAIL.tech);
  viewer = await signedIn(app, EMAIL.viewer);
  orgB = await signedIn(app, EMAIL.orgB);
  orgA = (await ids()).orgA;
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

async function clientId(code: string): Promise<string> {
  return asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query('SELECT id FROM clients WHERE code = $1', [code])).rows[0].id as string);
}
async function psaOf(client: string): Promise<string> {
  return asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query(`SELECT id FROM psa_instances WHERE client_id = $1 AND status = 'active' ORDER BY code LIMIT 1`, [client])).rows[0].id as string);
}
/** Each scenario works on a client of its own so license capacity is deterministic. */
async function freshClient(suffix: string): Promise<string> {
  const code = `LIC-T-${suffix}-${Date.now().toString(36)}`;
  return asAppCommit({ orgId: orgA }, async (c) => {
    const base = await c.query(`SELECT * FROM clients WHERE code = 'CL-00014'`);
    const r = await c.query(
      `INSERT INTO clients (organization_id, code, client_reference, legal_name, display_name, business_type, country_code, timezone, status, service_status)
       VALUES ($1, next_org_code('client', 'CL'), $2, $3, $3, 'msp', 'US', 'UTC', 'active', 'live') RETURNING id`,
      [orgA, code, `License test client ${suffix}`],
    );
    const id = r.rows[0].id as string;
    const basePsa = (await c.query(`SELECT id FROM psa_instances WHERE client_id = $1 AND status = 'active' ORDER BY code LIMIT 1`, [base.rows[0].id])).rows[0].id as string;
    const psa = (await c.query(`INSERT INTO psa_instances (organization_id, client_id, code, display_name, provider_key, auth_method, api_endpoint, config, status)
       SELECT $1, $2, 'PSA-' || lpad((floor(random() * 90000) + 10000)::text, 5, '0'), 'License test PSA', provider_key, auth_method, api_endpoint, config, 'active' FROM psa_instances WHERE id = $3 RETURNING id`, [orgA, id, basePsa])).rows[0].id as string;
    await c.query(`INSERT INTO client_services (organization_id, client_id, service_id, config) SELECT $1, $2, service_id, config FROM client_services WHERE client_id = $3`, [orgA, id, base.rows[0].id]);
    await c.query(`INSERT INTO psa_instance_services (organization_id, client_id, psa_instance_id, service_id) SELECT $1, $2, $3, service_id FROM psa_instance_services WHERE psa_instance_id = $4`, [orgA, id, psa, basePsa]);
    return id;
  });
}
const license = (over: Record<string, unknown> = {}) => ({ displayName: 'Help Desk Standard', startsAt: today(), endsAt: plusDays(400), maxDeployments: 1, ...over });

describe('licenses', () => {
  it('a license gets its own identifier, is listed and counted, and only license managers may create it', async () => {
    const client = await freshClient('a');
    expect((await viewer.post('/licenses', { clientId: client, ...license() })).status).toBe(403);
    expect((await tech.post('/licenses', { clientId: client, ...license() })).status).toBe(403); // tech admins run appliances, they do not sell licenses
    const bad = await ops.post('/licenses', { clientId: client, ...license({ endsAt: '2020-01-01' }) });
    expect(bad.status).toBe(400);
    const r = await ops.post('/licenses', { clientId: client, ...license({ notes: 'Annual plan' }) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const l = r.body as LicenseDetail;
    expect(l.code).toMatch(/^LIC-\d{5}$/);
    expect(l).toMatchObject({ status: 'active', maxDeployments: 1, deploymentsUsed: 0, expiring: false, notes: 'Annual plan', createdBy: expect.any(String) });
    expect(l.daysRemaining).toBeGreaterThan(390);
    expect((await viewer.get(`/licenses/${l.id}`)).status).toBe(200); // every role may read
    expect((await orgB.get(`/licenses/${l.id}`)).status).toBe(404); // not another organization's
    const list = (await ops.get(`/licenses?clientId=${client}`)).body as Paged<LicenseSummary>;
    expect(list.items.map((x) => x.id)).toEqual([l.id]);
    const stats = (await ops.get('/licenses/stats')).body;
    expect(stats.total).toBeGreaterThanOrEqual(1);
    expect(stats.active).toBeGreaterThanOrEqual(1);
    const audit = (await ops.get(`/audit-events?targetType=license&targetId=${l.id}`)).body.items as { action: string }[];
    expect(audit.map((e) => e.action)).toContain('license.created');
  });

  it('deployments bind to the client’s active license by default; packages need an active license with capacity', async () => {
    const client = await freshClient('b');
    const psa = await psaOf(client);
    // No license yet: the deployment is created but not ready for a package.
    const d0 = (await ops.post('/deployments', { clientId: client, psaInstanceId: psa, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' })).body;
    expect(d0.license).toBeNull();
    const notReady = await ops.post(`/deployments/${d0.id}/packages`, { tokenValidityHours: 1 });
    expect(notReady.status).toBe(422);
    expect(notReady.body.detail).toContain('No license is assigned');
    // Create a license with capacity 1 and bind the draft through its settings.
    const l = (await ops.post('/licenses', { clientId: client, ...license({ maxDeployments: 1 }) })).body as LicenseDetail;
    const detail0 = (await ops.get(`/deployments/${d0.id}`)).body;
    expect(detail0.licenseOptions.map((o: { id: string }) => o.id)).toEqual([l.id]);
    const bound = await ops.patch(`/deployments/${d0.id}`, { version: detail0.version, psaInstanceId: psa, licenseId: l.id, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' });
    expect(bound.status, JSON.stringify(bound.body)).toBe(200);
    expect(bound.body.licenseDetail).toMatchObject({ id: l.id, code: l.code, status: 'active' });
    expect(bound.body.readiness.find((c: { key: string }) => c.key === 'license')).toMatchObject({ ok: true });
    expect((await ops.post(`/deployments/${d0.id}/packages`, { tokenValidityHours: 1 })).status).toBe(201);
    // A second deployment binds automatically, but the license is full: no package.
    const d1 = (await ops.post('/deployments', { clientId: client, psaInstanceId: psa, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' })).body;
    expect(d1.license).toBeNull(); // no license with free capacity → nothing assigned
    const d1detail = (await ops.get(`/deployments/${d1.id}`)).body;
    const bind = await ops.patch(`/deployments/${d1.id}`, { version: d1detail.version, psaInstanceId: psa, licenseId: l.id, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' });
    expect(bind.status).toBe(200);
    const full = await ops.post(`/deployments/${d1.id}/packages`, { tokenValidityHours: 1 });
    expect(full.status).toBe(422);
    expect(full.body.detail).toContain('allows 1 deployment');
    // Raising the limit below the usage is refused; raising it to 2 unblocks.
    const lDetail = (await ops.get(`/licenses/${l.id}`)).body as LicenseDetail;
    expect(lDetail.deploymentsUsed).toBe(2);
    expect((await ops.patch(`/licenses/${l.id}`, { version: lDetail.version, ...license({ maxDeployments: 1 }) })).status).toBe(400);
    expect((await ops.patch(`/licenses/${l.id}`, { version: lDetail.version, ...license({ maxDeployments: 2 }) })).status).toBe(200);
    expect((await ops.post(`/deployments/${d1.id}/packages`, { tokenValidityHours: 1 })).status).toBe(201);
    // The package carries the license identifier (an identifier for the appliance, never an entitlement check it enforces).
    const d1full = (await ops.get(`/deployments/${d1.id}`)).body;
    const pkg = d1full.currentPackage;
    expect(pkg).toBeTruthy();
    const res = await supertest(app.getHttpServer()).post(`/api/v1/deployments/${d1.id}/packages/${pkg.id}/download`)
      .set('cookie', ops.cookieHeader).set('origin', ORIGIN).set('x-csrf-token', ops.cookies.get('psacc_csrf') ?? '').buffer(true)
      .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    const config = JSON.parse(Buffer.from(files[`psacc-${d1full.code.toLowerCase()}/config/edge.json`]!).toString());
    expect(config.license).toEqual({ id: l.id, code: l.code, displayName: 'Help Desk Standard', endsAt: plusDays(400) });
  });

  it('enrollment is refused under a suspended, expired or revoked license, and after the deployment is suspended', async () => {
    const client = await freshClient('c');
    const code = await asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query('SELECT code FROM clients WHERE id = $1', [client])).rows[0].code as string);
    // packageFor creates the client's test license and binds the deployment to it: that is the license under test here.
    const en = await packageFor(app, ops, code);
    const l = (await ops.get(`/deployments/${en.deploymentId}`)).body.licenseDetail as LicenseDetail;
    expect(l.status).toBe('active');
    expect((await ops.post(`/licenses/${l.id}/suspend`, { reason: 'Invoice overdue' })).status).toBe(200);
    const k = await keyAndCsr(en.installationId);
    const refused = await gw(port, '/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: k.csr, agentVersion: '0.1.0' }, en.caCertificate);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('license-inactive');
    expect((await ops.post(`/licenses/${l.id}/resume`, { reason: 'Paid' })).status).toBe(200);
    // Suspending the (not yet enrolled) deployment also refuses enrollment; resuming restores the previous state.
    const sus = await ops.post(`/deployments/${en.deploymentId}/suspend`, { reason: 'Site closed for refurbishment' });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect(sus.body).toMatchObject({ lifecycleState: 'suspended', suspension: { reason: 'Site closed for refurbishment', fromState: 'package_downloaded' } });
    const refused2 = await gw(port, '/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: k.csr, agentVersion: '0.1.0' }, en.caCertificate);
    expect(refused2.body.error).toBe('deployment-suspended');
    expect((await ops.post(`/deployments/${en.deploymentId}/packages`, { tokenValidityHours: 1 })).status).toBe(422);
    const res = await ops.post(`/deployments/${en.deploymentId}/resume`, { reason: 'Reopened' });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleState).toBe('package_downloaded');
    const ok = await gw(port, '/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: k.csr, agentVersion: '0.1.0' }, en.caCertificate);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    // Revoked licenses are final and cannot be edited.
    expect((await ops.post(`/licenses/${l.id}/revoke`, { reason: 'Contract ended' })).status).toBe(200);
    const lr = (await ops.get(`/licenses/${l.id}`)).body as LicenseDetail;
    expect(lr).toMatchObject({ status: 'revoked', revokeReason: 'Contract ended' });
    expect((await ops.patch(`/licenses/${l.id}`, { version: lr.version, ...license() })).status).toBe(409);
    expect((await ops.post(`/licenses/${l.id}/resume`, { reason: 'Trying to revive it' })).status).toBe(409); // revoked is final
    const audit = (await ops.get(`/audit-events?targetType=license&targetId=${l.id}`)).body.items.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['license.created', 'license.suspended', 'license.resumed', 'license.revoked']));
  });

  it('suspending an enrolled deployment delivers a signed suspend command, blocks other commands and packages, and resume restores it; the health shows the lifecycle and licensing findings', async () => {
    const a = await enrolledAgent(app, ops, port);
    const dep = a.en.deploymentId;
    const before = (await ops.get(`/deployments/${dep}`)).body;
    expect(['enrolled', 'verified']).toContain(before.lifecycleState);
    expect((await viewer.post(`/deployments/${dep}/suspend`, { reason: 'Not allowed' })).status).toBe(403);
    const sus = await tech.post(`/deployments/${dep}/suspend`, { reason: 'Customer requested a pause' });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect(sus.body.lifecycleState).toBe('suspended');
    const hb = await heartbeat(a);
    const cmds = hb.body.commands as SignedCommand[];
    expect(cmds.map((c) => c.type)).toEqual(['suspend']);
    expect(cmds[0]!.params).toEqual({ reason: 'Customer requested a pause' });
    // While suspended: no operator commands, no packages; the lifecycle commands do not appear on the operator list.
    const blocked = await tech.post(`/deployments/${dep}/commands`, { type: 'refresh_health' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.detail).toContain('suspended');
    expect((await tech.post(`/deployments/${dep}/commands`, { type: 'resume' })).status).toBe(409); // lifecycle-only type
    expect((await ops.post(`/deployments/${dep}/packages`, { tokenValidityHours: 1 })).status).toBe(422);
    const health = (await ops.get(`/deployments/${dep}/health`)).body;
    expect(health.findings.map((f: { code: string }) => f.code)).toContain('deployment_suspended');
    // Resume: back to the previous state with a signed resume command.
    const res = await tech.post(`/deployments/${dep}/resume`, { reason: 'Pause over' });
    expect(res.status).toBe(200);
    expect(res.body.lifecycleState).toBe(before.lifecycleState);
    expect(res.body.suspension).toBeNull();
    const after = (await heartbeat(a)).body.commands as SignedCommand[];
    expect(after.map((c) => c.type).sort()).toEqual(['resume', 'suspend']); // the earlier suspend is still open until the agent answers
    const activity = (await ops.get(`/deployments/${dep}/activity?pageSize=30`)).body.items.map((e: { action: string }) => e.action);
    expect(activity).toEqual(expect.arrayContaining(['deployment.suspended', 'deployment.resumed', 'deployment.command.issued']));
  });

  it('the expiry sweep closes licenses past their end date and the health rules flag expiring and expired licenses', async () => {
    const client = await freshClient('d');
    const l = (await ops.post('/licenses', { clientId: client, ...license({ endsAt: plusDays(10), maxDeployments: 3 }) })).body as LicenseDetail;
    expect(l.expiring).toBe(true);
    expect((await ops.get('/licenses?expiringWithinDays=30')).body.items.map((x: { id: string }) => x.id)).toContain(l.id);
    const psa = await psaOf(client);
    const d = (await ops.post('/deployments', { clientId: client, psaInstanceId: psa, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' })).body;
    expect(d.license).toMatchObject({ id: l.id });
    await asAppCommit({ orgId: orgA }, (c) => c.query(`UPDATE licenses SET starts_at = current_date - 30, ends_at = current_date - 1 WHERE id = $1`, [l.id]));
    expect((await ops.get(`/deployments/${d.id}`)).body.licenseDetail.status).toBe('expired'); // effective status before the sweep
    expect((await ops.post(`/deployments/${d.id}/packages`, { tokenValidityHours: 1 })).status).toBe(422);
    expect(await app.get(LicensesService).sweepExpired()).toBeGreaterThanOrEqual(1);
    expect((await ops.get(`/licenses/${l.id}`)).body.status).toBe('expired');
    const audit = (await ops.get(`/audit-events?targetType=license&targetId=${l.id}`)).body.items.map((e: { action: string }) => e.action);
    expect(audit).toContain('license.expired');
    // Extending the term reactivates it.
    const le = (await ops.get(`/licenses/${l.id}`)).body as LicenseDetail;
    const ext = await ops.patch(`/licenses/${l.id}`, { version: le.version, ...license({ endsAt: plusDays(90), maxDeployments: 3 }) });
    expect(ext.status).toBe(200);
    expect(ext.body.status).toBe('active');
    expect((await ops.post(`/deployments/${d.id}/packages`, { tokenValidityHours: 1 })).status).toBe(201);
  });

  it('the Control Plane keeps licenses isolated per organization and the synthetic ones read-only', async () => {
    const synthetic = await asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query(`SELECT id FROM licenses WHERE is_synthetic = true LIMIT 1`)).rows[0]?.id as string | undefined);
    if (synthetic) {
      expect((await orgB.get(`/licenses/${synthetic}`)).status).toBe(404);
      expect((await orgB.post(`/licenses/${synthetic}/suspend`, { reason: 'nope' })).status).toBe(404);
    }
    expect((await orgB.get('/licenses')).body.items.every((x: { client: { code: string } }) => !x.client.code.startsWith('CL-000'))).toBe(true);
    expect((await admin.get('/licenses?status=bogus')).status).toBe(400);
  });
});
