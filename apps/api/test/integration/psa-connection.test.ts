import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { type AgentIdentity, enrolledAgent, gw, healthyReports } from './agent-helpers.js';
import { type Client, EMAIL, asApp, ids, signedIn, startApp } from './helpers.js';

/**
 * Module 11 — PSA connection status is a projection of what the appliance reports after running the real
 * test there. These tests simulate the agent's `psa_integration_status` reports over the mTLS gateway and
 * check the instance status, the audit trail, the history endpoint and the Integrations fleet view.
 */
let app: NestExpressApplication;
let port: number;
let ops: Client;
beforeAll(async () => {
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '100' });
  const g = app.get(AgentGateway);
  await g.start(0, '127.0.0.1');
  port = g.address!.port;
  ops = await signedIn(app, EMAIL.ops);
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

const send = (a: AgentIdentity, body: unknown) => gw(port, '/agent/v1/reports', body, a.en.caCertificate, a);
const instanceOf = async (a: AgentIdentity) => (await ops.get(`/deployments/${a.en.deploymentId}`)).body.psaInstance as { id: string; code: string };
const psaReport = (instanceCode: string, over: Record<string, unknown>) => ({
  provider: 'autotask', instanceCode, status: 'credentials_present', credentialFields: 3, credentialsPresent: 3, lastTestAt: null, lastTestResult: null, apiCallsImplemented: true, ...over,
});

describe('PSA connection status reported by the appliance', () => {
  it('a verified test marks the instance succeeded (with the real success time), a failed auth marks credentials invalid, and both are audited', async () => {
    const a = await enrolledAgent(app, ops, port);
    const inst = await instanceOf(a);
    expect((await ops.get(`/psa-instances/${inst.id}`)).body).toMatchObject({ connectionStatus: 'untested' }); // other suites may already have enrolled an appliance here

    const t1 = new Date(Date.now() - 60_000).toISOString();
    const ok = await send(a, healthyReports({ psa_integration_status: psaReport(inst.code, {
      status: 'verified', lastTestAt: t1, lastTestResult: 'ok', lastTestCode: 'ok', lastTestHttpStatus: 200, lastTestLatencyMs: 412, lastTestedBy: 'local_admin', lastSuccessAt: t1,
      remoteIdentity: { api: 'Autotask REST v1.0', host: 'webservices5.autotask.net' }, consecutiveFailures: 0, testsLast24h: 1, failedTestsLast24h: 0,
    }) }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    let d = (await ops.get(`/psa-instances/${inst.id}`)).body;
    expect(d).toMatchObject({ connectionStatus: 'succeeded', credentialStatus: 'configured', lastSuccessfulTestAt: t1 });
    expect(d.appliance).toMatchObject({ deployment: { id: a.en.deploymentId, code: a.en.deploymentCode }, status: 'verified', lastTestCode: 'ok', lastTestHttpStatus: 200, lastTestLatencyMs: 412, lastTestedBy: 'local_admin', apiCallsImplemented: true, remoteIdentity: { api: 'Autotask REST v1.0' } });
    expect((await ops.get('/psa-instances?connectionStatus=succeeded')).body.items.map((i: { id: string }) => i.id)).toContain(inst.id);

    const t2 = new Date().toISOString();
    const failed = await send(a, healthyReports({ psa_integration_status: psaReport(inst.code, {
      status: 'failed', lastTestAt: t2, lastTestResult: 'auth_failed', lastTestCode: 'auth_failed', lastTestHttpStatus: 401, lastTestLatencyMs: 230, lastTestedBy: 'worker', lastSuccessAt: t1, consecutiveFailures: 1,
    }) }));
    expect(failed.body.healthState).toBe('degraded');
    d = (await ops.get(`/psa-instances/${inst.id}`)).body;
    expect(d).toMatchObject({ connectionStatus: 'failed', credentialStatus: 'invalid', lastSuccessfulTestAt: t1 });
    const health = (await ops.get(`/deployments/${a.en.deploymentId}/health`)).body;
    expect(health.findings.map((f: { code: string; message: string }) => f.code)).toContain('psa_failed');
    expect(health.findings.find((f: { code: string }) => f.code === 'psa_failed').message).toContain('auth_failed, HTTP 401');

    // A non-auth failure keeps the credentials "configured"; a changed credential set goes back to untested.
    await send(a, healthyReports({ psa_integration_status: psaReport(inst.code, { status: 'failed', lastTestAt: new Date().toISOString(), lastTestCode: 'endpoint_unreachable', lastTestedBy: 'worker', lastSuccessAt: t1, consecutiveFailures: 2 }) }));
    expect((await ops.get(`/psa-instances/${inst.id}`)).body).toMatchObject({ connectionStatus: 'failed', credentialStatus: 'configured' });
    await send(a, healthyReports({ psa_integration_status: psaReport(inst.code, { status: 'credentials_present' }) }));
    expect((await ops.get(`/psa-instances/${inst.id}`)).body).toMatchObject({ connectionStatus: 'untested', credentialStatus: 'configured', lastSuccessfulTestAt: t1 });

    const audit = (await ops.get(`/psa-instances/${inst.id}/activity`)).body.items as { action: string; actorType: string; outcome: string; metadata: Record<string, unknown> }[];
    const reported = audit.filter((e) => e.action === 'psa_instance.connection.reported');
    expect(reported.length).toBe(4);
    expect(reported[reported.length - 1]).toMatchObject({ actorType: 'agent', outcome: 'success', metadata: { code: 'ok', httpStatus: 200, testedBy: 'local_admin', to: { connectionStatus: 'succeeded', authStatus: 'configured' } } });
    expect(reported[reported.length - 2]).toMatchObject({ outcome: 'failure', metadata: { code: 'auth_failed', httpStatus: 401, to: { connectionStatus: 'failed', authStatus: 'invalid' } } });
    expect(JSON.stringify(audit)).not.toMatch(/secret|password|apiKey/i);
  });

  it('the history endpoint lists one row per test (not per report), newest first, and the fleet view carries the appliance status', async () => {
    const a = await enrolledAgent(app, ops, port, 'CL-00015');
    const inst = await instanceOf(a);
    const t1 = new Date(Date.now() - 120_000).toISOString();
    const t2 = new Date(Date.now() - 60_000).toISOString();
    for (const [i, over] of [
      { status: 'failed', lastTestAt: t1, lastTestCode: 'tls_error', lastTestedBy: 'local_admin', consecutiveFailures: 1 },
      { status: 'failed', lastTestAt: t1, lastTestCode: 'tls_error', lastTestedBy: 'local_admin', consecutiveFailures: 1 }, // repeated report, same test
      { status: 'verified', lastTestAt: t2, lastTestCode: 'ok', lastTestHttpStatus: 200, lastTestLatencyMs: 300, lastTestedBy: 'local_admin', lastSuccessAt: t2, consecutiveFailures: 0 },
    ].entries()) {
      const r = await send(a, healthyReports({ psa_integration_status: psaReport(inst.code, over) }, new Date(Date.now() - 30_000 + i * 1000)));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const tests = (await ops.get(`/psa-instances/${inst.id}/connection-tests`)).body as { testedAt: string; ok: boolean; code: string; deployment: { code: string } }[];
    expect(tests.map((t) => [t.testedAt, t.ok, t.code])).toEqual([[t2, true, 'ok'], [t1, false, 'tls_error']]);
    expect(tests[0]!.deployment.code).toBe(a.en.deploymentCode);
    expect((await ops.get(`/psa-instances/${inst.id}/connection-tests?limit=1`)).body).toHaveLength(1);

    // Module 12: synchronization and ticket counters ride along in the appliance status.
    const r12 = await send(a, healthyReports({
      psa_integration_status: psaReport(inst.code, { status: 'verified', lastTestAt: t2, lastTestCode: 'ok', lastSuccessAt: t2 }),
      synchronization: { lastRunAt: t2, lastStatus: 'partial', itemsReceived: 12, itemsSent: 1, itemsFailed: 1, errorCode: 'push_failed', httpStatus: null, recentErrors: [], errorsLast24h: 1, implemented: true, lastSucceededAt: t1, runsLast24h: 3, failedRunsLast24h: 0, watermark: t2 },
      ticket_processing_metrics: { ticketsTotal: 40, ticketsOpen: 7, eventsLast24h: 15, failedLast24h: 1, lastProcessedAt: t2, pendingOutbound: 1, conflictsLast24h: 1, localOnly: 0, pushFailed: 1 },
    }, new Date(Date.now() - 20_000)));
    expect(r12.status, JSON.stringify(r12.body)).toBe(200);
    const withSync = (await ops.get(`/psa-instances/${inst.id}`)).body;
    expect(withSync.appliance.sync).toMatchObject({ implemented: true, lastStatus: 'partial', itemsReceived: 12, itemsSent: 1, itemsFailed: 1, errorCode: 'push_failed', runsLast24h: 3 });
    expect(withSync.appliance.tickets).toMatchObject({ total: 40, open: 7, pendingOutbound: 1, conflictsLast24h: 1 });
    expect(withSync.lastSyncAt).toBe(new Date(t1).toISOString()); // the instance's last successful synchronization follows the report
    const findings = (await ops.get(`/deployments/${a.en.deploymentId}/health`)).body.findings.map((f: { code: string }) => f.code);
    expect(findings).toEqual(expect.arrayContaining(['sync_partial', 'sync_conflicts']));
    expect(JSON.stringify(withSync)).not.toMatch(/title|description/i); // counts only, never ticket content

    const fleet = (await ops.get('/integrations')).body as { id: string; connectionStatus: string; appliance: { lastTestCode: string; sync: { lastStatus: string } | null; tickets: { total: number } | null } | null }[];
    const row = fleet.find((r) => r.id === inst.id)!;
    expect(row).toMatchObject({ connectionStatus: 'succeeded', appliance: { lastTestCode: 'ok', status: 'verified', sync: { lastStatus: 'partial' }, tickets: { total: 40 } } });
    const live = (await ops.get('/integrations?live=1')).body as { isSynthetic: boolean }[];
    expect(live.every((r) => !r.isSynthetic)).toBe(true);
    expect((await ops.get('/integrations?connectionStatus=succeeded')).body.map((r: { id: string }) => r.id)).toContain(inst.id);
    expect((await ops.get('/integrations?provider=jira')).status).toBe(400);
    // Fleet order: failed first, then untested, then succeeded.
    const order = (await ops.get('/integrations')).body.map((r: { connectionStatus: string }) => r.connectionStatus);
    const rank = (s: string) => ['failed', 'untested', 'succeeded'].indexOf(s);
    for (let i = 1; i < order.length; i++) expect(rank(order[i])).toBeGreaterThanOrEqual(rank(order[i - 1]));
  });

  it('reports naming another instance code are ignored; RBAC and tenant isolation hold', async () => {
    const a = await enrolledAgent(app, ops, port, 'CL-00016');
    const inst = await instanceOf(a);
    const r = await send(a, healthyReports({ psa_integration_status: psaReport('PSA-99999', { status: 'verified', lastTestAt: new Date().toISOString(), lastTestCode: 'ok', lastSuccessAt: new Date().toISOString() }) }));
    expect(r.status).toBe(200);
    expect((await ops.get(`/psa-instances/${inst.id}`)).body).toMatchObject({ connectionStatus: 'untested' });

    // integrations.read is part of every system role: the fleet view is read-only and carries no credentials.
    for (const email of [EMAIL.viewer, EMAIL.technician, EMAIL.service, EMAIL.tech, EMAIL.auditor]) expect((await (await signedIn(app, email)).get('/integrations')).status, email).toBe(200);
    expect((await (await signedIn(app, EMAIL.viewer)).get(`/psa-instances/${inst.id}/connection-tests`)).status).toBe(200); // psa.read suffices for the instance history
    const b = await signedIn(app, EMAIL.orgB);
    expect((await b.get(`/psa-instances/${inst.id}/connection-tests`)).status).toBe(404);
    expect((await b.get('/integrations')).body.some((x: { id: string }) => x.id === inst.id)).toBe(false);

    // The database constraint still forbids "succeeded" without a real success time, whatever the path.
    const { orgA } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(c.query(`UPDATE psa_instances SET connection_status = 'succeeded', last_successful_test_at = NULL WHERE id = $1`, [inst.id])).rejects.toThrow(/psa_instances_verified_requires_test/);
    });
  });
});
