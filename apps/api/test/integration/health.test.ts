import type { NestExpressApplication } from '@nestjs/platform-express';
import { DEFAULT_HEALTH_POLICY } from '@psacc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { HealthService } from '../../src/modules/health/health.service.js';
import { type AgentIdentity, enrolledAgent, gw, healthyReports } from './agent-helpers.js';
import { type Client, EMAIL, asApp, asAppCommit, ids, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
let port = 0;
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
const health = async (a: AgentIdentity) => (await ops.get(`/deployments/${a.en.deploymentId}/health`)).body;
const detail = async (a: AgentIdentity) => (await ops.get(`/deployments/${a.en.deploymentId}`)).body;
async function orgA() {
  return (await ids()).orgA;
}

describe('agent reports and the health rules engine', () => {
  it('after enrollment a heartbeat alone leaves the deployment unknown, with an honest reason', async () => {
    const a = await enrolledAgent(app, ops, port);
    expect(await health(a)).toMatchObject({ healthState: 'unknown', healthReason: 'Awaiting the first agent reports', heartbeats: [] }); // evaluated on enrollment
    expect(await gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a)).toMatchObject({ status: 200 });
    const h = await health(a);
    expect(h).toMatchObject({ healthState: 'unknown', healthReason: 'Awaiting the first agent reports', lifecycleState: 'enrolled' });
    expect(h.heartbeats.length).toBeGreaterThanOrEqual(1);
  });

  it('a full healthy report set makes the deployment healthy and verified; reports are stored per type', async () => {
    const a = await enrolledAgent(app, ops, port);
    const r = await send(a, healthyReports());
    expect(r).toMatchObject({ status: 200, body: { accepted: 9, rejected: [], healthState: 'healthy' } });
    const d = await detail(a);
    expect(d).toMatchObject({ lifecycleState: 'verified', healthState: 'healthy', healthReason: null });
    expect(d.verifiedAt).not.toBeNull();
    const h = await health(a);
    expect(Object.keys(h.latest).sort()).toEqual(['backup', 'certificates_security', 'containers', 'database', 'host_resources', 'psa_integration_status', 'synchronization', 'ticket_processing_metrics', 'versions']);
    expect(h.latest.database.payload.tables.map((t: { name: string }) => t.name)).toEqual(['helpdesk_tickets', 'app_metadata']);
    expect(h.resourceHistory).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ healthState: 'healthy', source: 'agent' });
    const audit = (await ops.get(`/deployments/${a.en.deploymentId}/activity`)).body.items.map((e: { action: string }) => e.action);
    expect(audit).toContain('deployment.verified');
  });

  it('reports are strict: unknown fields, free text where a code is expected, and out-of-window times are rejected and audited', async () => {
    const a = await enrolledAgent(app, ops, port);
    const bad = healthyReports();
    (bad.reports[0]!.payload as Record<string, unknown>).ticketTitle = 'Printer on fire'; // database report with an extra field
    (bad.reports[5]!.payload as Record<string, unknown>).errorCode = 'Authorization: Bearer abc'; // synchronization: not a code
    bad.reports[1]!.observedAt = new Date(Date.now() + 3_600_000).toISOString(); // host_resources: in the future
    const r = await send(a, bad);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(6);
    expect((r.body.rejected as { type: string }[]).map((x) => x.type).sort()).toEqual(['database', 'host_resources', 'synchronization']);
    expect(await detail(a)).toMatchObject({ healthState: 'unknown' }); // no accepted database report
    const audit = (await ops.get(`/deployments/${a.en.deploymentId}/activity`)).body.items.find((e: { action: string }) => e.action === 'agent.report.rejected');
    expect(audit.metadata.rejected).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain('Printer on fire');
    expect((await send(a, { agentVersion: '0.1.0', reports: [{ schemaVersion: 1, type: 'ticket_content', observedAt: new Date().toISOString(), payload: {} }] })).status).toBe(400);
    expect((await send(a, { agentVersion: '0.1.0', reports: [] })).status).toBe(400);
    expect((await gw(port, '/agent/v1/reports', healthyReports(), a.en.caCertificate)).status).toBe(401); // no certificate
  });

  it('states follow the rules: database down → critical, high disk → degraded, recovery → healthy; each change is an event', async () => {
    const a = await enrolledAgent(app, ops, port);
    await send(a, healthyReports());
    await send(a, healthyReports({ database: { available: false, error: 'database_unavailable' }, containers: { services: [{ name: 'edge-postgres', probe: 'database', state: 'down', detail: 'database_unavailable' }] } }, new Date(Date.now() + 1000)));
    expect(await detail(a)).toMatchObject({ healthState: 'critical', healthReason: 'PostgreSQL is not available (database_unavailable). edge-postgres is down (database_unavailable).' });
    await send(a, healthyReports({ host_resources: { diskUsedBytes: 90_000_000_000 } }, new Date(Date.now() + 2000)));
    const h = await health(a);
    expect(h).toMatchObject({ healthState: 'degraded', findings: [{ code: 'disk_warn', severity: 'degraded' }] });
    await send(a, healthyReports({}, new Date(Date.now() + 3000)));
    const final = await health(a);
    expect(final.healthState).toBe('healthy');
    expect(final.events.map((e: { healthState: string }) => e.healthState)).toEqual(['healthy', 'degraded', 'critical', 'healthy']);
    expect(final.resourceHistory).toHaveLength(4);
  });

  it('the sweep marks a deployment offline when heartbeats stop, and a heartbeat brings it back', async () => {
    const a = await enrolledAgent(app, ops, port);
    await send(a, healthyReports());
    await asAppCommit({ orgId: await orgA() }, (c) => c.query(`UPDATE deployments SET last_heartbeat_at = now() - interval '10 minutes' WHERE id = $1`, [a.en.deploymentId]));
    await app.get(HealthService).sweep();
    const off = await health(a);
    expect(off.healthState).toBe('offline');
    expect(off.healthReason).toMatch(/^Offline: last heartbeat/);
    expect(off.events[0]).toMatchObject({ healthState: 'offline', source: 'system' });
    await gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a);
    expect((await health(a)).healthState).toBe('healthy'); // reports are still fresh
  });

  it('the health policy is centrally configured, validated, audited, and applied immediately', async () => {
    expect((await ops.get('/monitoring/policy')).body).toEqual(DEFAULT_HEALTH_POLICY);
    const a = await enrolledAgent(app, ops, port);
    await send(a, healthyReports()); // disk at 40 %
    const admin = await signedIn(app, EMAIL.admin);
    expect((await (await signedIn(app, EMAIL.technician)).put('/monitoring/policy', DEFAULT_HEALTH_POLICY)).status).toBe(403);
    expect((await admin.put('/monitoring/policy', { ...DEFAULT_HEALTH_POLICY, diskWarnPercent: 96 })).body.errors[0].path).toBe('diskCriticalPercent');
    expect((await admin.put('/monitoring/policy', { ...DEFAULT_HEALTH_POLICY, offlineAfterSeconds: 60 })).body.errors[0].path).toBe('offlineAfterSeconds');
    const r = await admin.put('/monitoring/policy', { ...DEFAULT_HEALTH_POLICY, diskWarnPercent: 30, heartbeatIntervalSeconds: 30, offlineAfterSeconds: 120 });
    expect(r.status).toBe(200);
    expect((await health(a)).healthState).toBe('degraded'); // re-evaluated with the new threshold
    expect((await gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a)).body).toMatchObject({ heartbeatIntervalSeconds: 30 });
    try {
      const audit = (await admin.get('/audit-events?action=health_policy.updated')).body.items[0];
      expect(audit.metadata.changes.diskWarnPercent).toEqual({ from: 80, to: 30 });
    } finally {
      await admin.put('/monitoring/policy', DEFAULT_HEALTH_POLICY);
    }
  });

  it('fleet view: counts per state, synthetic rows labelled separately, live-only filter, RBAC and isolation', async () => {
    const a = await enrolledAgent(app, ops, port);
    await send(a, healthyReports());
    const fleet = (await ops.get('/monitoring/fleet')).body;
    const mine = fleet.rows.find((r: { id: string }) => r.id === a.en.deploymentId);
    expect(mine, JSON.stringify(mine)).toMatchObject({ healthState: 'healthy', isSynthetic: false, cpuPercent: 12.5, memoryPercent: 15, diskPercent: 40, databaseAvailable: true });
    expect(fleet.syntheticSummary.healthy).toBeGreaterThan(0);
    expect(fleet.summary.healthy).toBeGreaterThan(fleet.syntheticSummary.healthy);
    const live = (await ops.get('/monitoring/fleet?live=1')).body;
    expect(live.rows.every((r: { isSynthetic: boolean }) => !r.isSynthetic)).toBe(true);
    expect((await ops.get('/monitoring/fleet?state=sick')).status).toBe(400);
    for (const email of [EMAIL.viewer, EMAIL.auditor]) {
      const c = await signedIn(app, email);
      expect((await c.get('/monitoring/fleet')).status, email).toBe(200);
      expect((await c.put('/monitoring/policy', DEFAULT_HEALTH_POLICY)).status, email).toBe(403);
    }
    const tech = await signedIn(app, EMAIL.technician);
    expect((await tech.get(`/deployments/${a.en.deploymentId}/health`)).status).toBe(404); // not an assigned client
    const b = await signedIn(app, EMAIL.orgB);
    expect((await b.get(`/deployments/${a.en.deploymentId}/health`)).status).toBe(404);
    expect((await b.get('/monitoring/fleet')).body.rows.every((r: { id: string }) => r.id !== a.en.deploymentId)).toBe(true);
    await asApp(null, async (c) => {
      for (const t of ['deployment_reports', 'deployment_report_latest', 'deployment_heartbeats', 'health_policies']) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      }
    });
  });
});
