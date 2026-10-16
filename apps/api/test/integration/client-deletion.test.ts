import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLIENT_DELETION_AUDIT_ACTION } from '@psacc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { type AgentIdentity, enrolledAgent, gw, healthyReports } from './agent-helpers.js';
import { type Client, EMAIL, asApp, ids, signedIn, startApp } from './helpers.js';

/**
 * Module 17 — Client-initiated deletion from the appliance. The appliance's local administrator asks for
 * everything to be deleted; the agent sends the request over its mutual-TLS identity; the Control Plane
 * deletes every record it holds about the deployment in one transaction and keeps one audit event.
 */
let app: NestExpressApplication;
let port: number;
let ops: Client;
let admin: Client;

const heartbeat = (a: AgentIdentity) => gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a);
const del = (a: AgentIdentity, body: Record<string, unknown>) => gw(port, '/agent/v1/delete', body, a.en.caCertificate, a);
const request = (a: AgentIdentity, over: Record<string, unknown> = {}) => ({ installationId: a.en.installationId, requestedBy: 'localadmin', reason: 'Contract ended; the client leaves', requestedAt: new Date().toISOString(), ...over });

beforeAll(async () => {
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '100' });
  const g = app.get(AgentGateway);
  await g.start(0, '127.0.0.1');
  port = g.address!.port;
  ops = await signedIn(app, EMAIL.ops);
  admin = await signedIn(app, EMAIL.admin);
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

describe('client-initiated deletion', () => {
  it('deletes everything about the deployment in one transaction and leaves exactly one audit event', async () => {
    const a = await enrolledAgent(app, ops, port);
    // A lived-in deployment: heartbeats and reports on record.
    expect((await heartbeat(a)).status).toBe(200);
    expect((await gw(port, '/agent/v1/reports', healthyReports(), a.en.caCertificate, a)).status).toBe(200);
    const before = (await ops.get(`/deployments/${a.en.deploymentId}`)).body;
    expect(before.lifecycleState).toBe('verified');
    const licenseId = before.licenseDetail.id as string;
    const seatsBefore = (await ops.get(`/licenses/${licenseId}`)).body.deploymentsUsed as number;

    const r = await del(a, request(a));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'deleted', deploymentCode: before.code });
    const deleted = r.body.deleted as Record<string, number>;
    expect(deleted.deployments).toBe(1);
    expect(deleted.certificates).toBeGreaterThanOrEqual(1);
    expect(deleted.heartbeats).toBeGreaterThanOrEqual(1);
    expect(deleted.reports).toBeGreaterThanOrEqual(1);
    expect(deleted.packages).toBe(1);

    // Gone from the Control Plane: detail, list, health; the license seat is free again.
    expect((await ops.get(`/deployments/${a.en.deploymentId}`)).status).toBe(404);
    expect(((await ops.get('/deployments?pageSize=100')).body.items as { id: string }[]).some((d) => d.id === a.en.deploymentId)).toBe(false);
    expect((await ops.get(`/licenses/${licenseId}`)).body.deploymentsUsed).toBe(seatsBefore - 1);
    const { orgA } = await ids();
    const rows = await asApp({ orgId: orgA, scopeAll: true }, async (c) => ({
      reports: Number((await c.query('SELECT count(*) FROM deployment_reports WHERE deployment_id = $1', [a.en.deploymentId])).rows[0].count),
      certs: Number((await c.query('SELECT count(*) FROM agent_certificates WHERE deployment_id = $1', [a.en.deploymentId])).rows[0].count),
      heartbeats: Number((await c.query('SELECT count(*) FROM deployment_heartbeats WHERE deployment_id = $1', [a.en.deploymentId])).rows[0].count),
      tokens: Number((await c.query('SELECT count(*) FROM enrollment_tokens WHERE deployment_id = $1', [a.en.deploymentId])).rows[0].count),
    }));
    expect(rows).toEqual({ reports: 0, certs: 0, heartbeats: 0, tokens: 0 });

    // The audit event is the only trace: on the client, with the counts, who asked and which certificate.
    const events = (await admin.get(`/audit-events?action=${CLIENT_DELETION_AUDIT_ACTION}&pageSize=20`)).body.items as Record<string, unknown>[];
    const ev = events.find((e) => e.targetId === a.en.deploymentId)!;
    expect(ev).toBeTruthy();
    expect(ev.id).toBe(r.body.auditEventId);
    expect(ev).toMatchObject({ actorType: 'agent', targetDisplay: before.code, outcome: 'success' });
    const { enrollmentTokens, ...rest } = deleted;
    expect(ev.metadata).toMatchObject({ code: before.code, requestedBy: 'localadmin', reason: 'Contract ended; the client leaves', installationId: a.en.installationId, lifecycleState: 'verified', deleted: { ...rest, enrollments: enrollmentTokens } });
    expect(JSON.stringify(ev.metadata)).not.toContain('REDACTED'); // nothing in the trail is masked away
    expect((ev.metadata as { certificateFingerprint: string }).certificateFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The certificate is unknown now; a retry of the same request is answered "already deleted" (the agent can finish its wipe).
    expect((await heartbeat(a)).status).toBe(401);
    const again = await del(a, request(a));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'already-deleted', deploymentCode: before.code, auditEventId: ev.id, deleted: {} });
  });

  it('refuses a request that names another installation, a malformed one, and a stranger', async () => {
    const a = await enrolledAgent(app, ops, port);
    const b = await enrolledAgent(app, ops, port);
    const wrong = await del(a, request(a, { installationId: b.en.installationId }));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('installation-mismatch');
    const bad = await del(a, { installationId: a.en.installationId });
    expect(bad.status).toBe(400);
    expect((await del(a, request(a, { password: 'never' }))).status).toBe(400);
    // Nothing happened to either deployment.
    expect((await ops.get(`/deployments/${a.en.deploymentId}`)).status).toBe(200);
    expect((await ops.get(`/deployments/${b.en.deploymentId}`)).status).toBe(200);
    // Without a certificate the route does not exist for the caller.
    expect((await gw(port, '/agent/v1/delete', request(a), a.en.caCertificate)).status).toBe(401);
  });

  it('is refused with a revoked certificate (the provider retired the identity for a reason) but allowed for a decommissioned deployment', async () => {
    const a = await enrolledAgent(app, ops, port);
    expect((await admin.post(`/deployments/${a.en.deploymentId}/agent-certificate/revoke`, { reason: 'Host compromised' })).status).toBe(200);
    const r = await del(a, request(a));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('revoked');
    expect((await ops.get(`/deployments/${a.en.deploymentId}`)).status).toBe(200);

    const b = await enrolledAgent(app, ops, port);
    const code = (await ops.get(`/deployments/${b.en.deploymentId}`)).body.code as string;
    expect((await admin.post(`/deployments/${b.en.deploymentId}/decommission`, { reason: 'Site closed', confirmCode: code })).status).toBe(200);
    const d = await del(b, request(b));
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ status: 'deleted', deploymentCode: code });
    expect((await ops.get(`/deployments/${b.en.deploymentId}`)).status).toBe(404);
    const ev = ((await admin.get(`/audit-events?action=${CLIENT_DELETION_AUDIT_ACTION}&pageSize=20`)).body.items as Record<string, unknown>[]).find((e) => e.targetId === b.en.deploymentId)!;
    expect(ev.metadata).toMatchObject({ lifecycleState: 'decommissioned' });
    expect((ev.metadata as { decommissionedAt: string | null }).decommissionedAt).toBeTruthy();
  });

  it('still refuses deletion as a remote command: only the appliance side can start it', async () => {
    const a = await enrolledAgent(app, ops, port);
    for (const type of ['delete', 'wipe', 'uninstall', 'decommission']) {
      const r = await admin.post(`/deployments/${a.en.deploymentId}/commands`, { type, reason: 'never' });
      expect(r.status, type).toBe(400);
    }
  });

  it('explicit removal by the provider still needs a decommissioned deployment (the client-initiated path is not a shortcut for operators)', async () => {
    const a = await enrolledAgent(app, ops, port);
    const code = (await ops.get(`/deployments/${a.en.deploymentId}`)).body.code as string;
    const r = await admin.del(`/deployments/${a.en.deploymentId}`, { confirmCode: code });
    expect(r.status).toBe(409);
  });
});
