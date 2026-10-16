import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DeploymentDetail, RetentionPolicyDto } from '@psacc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { RetentionService } from '../../src/modules/deployments/retention.service.js';
import { type AgentIdentity, enrolledAgent, gw, healthyReports, keyAndCsr, packageFor } from './agent-helpers.js';
import { type Client, EMAIL, asAppCommit, ids, signedIn, startApp } from './helpers.js';

/**
 * Module 15 — Secure decommissioning and deployment removal. Decommissioning retires the management
 * identity on the Control Plane (certificate, tokens, package, open commands), the gateway answers
 * `decommissioned` from then on, nothing on the host is touched, metadata is purged after the retention
 * period, and the record can be removed explicitly afterwards. Audit events stay.
 */
let app: NestExpressApplication;
let port: number;
let ops: Client;
let admin: Client;
let tech: Client;
let viewer: Client;
let orgB: Client;
let orgA = '';

const heartbeat = (a: AgentIdentity) => gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a);
const reports = (a: AgentIdentity) => gw(port, '/agent/v1/reports', healthyReports(), a.en.caCertificate, a);
const detail = async (id: string) => (await ops.get(`/deployments/${id}`)).body as DeploymentDetail;
const activity = async (id: string) => ((await ops.get(`/deployments/${id}/activity?pageSize=50`)).body.items as { action: string; metadata: Record<string, unknown> }[]);

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

describe('decommissioning an enrolled deployment', () => {
  it('retires the identity on the Control Plane, is final, is audited, and the appliance learns it from the gateway', async () => {
    const a = await enrolledAgent(app, ops, port);
    const id = a.en.deploymentId;
    expect((await reports(a)).status).toBe(200);
    // An open command exists before decommissioning (it is cancelled by it).
    const cmd = await tech.post(`/deployments/${id}/commands`, { type: 'refresh_health' });
    expect(cmd.status, JSON.stringify(cmd.body)).toBe(201);
    const before = await detail(id);
    expect(['enrolled', 'verified']).toContain(before.lifecycleState);
    expect(before.decommission).toBeNull();

    // Validation: the deployment ID must be typed exactly; a reason is required.
    expect((await ops.post(`/deployments/${id}/decommission`, { reason: 'Site closed', confirmCode: 'DEP-99999' })).status).toBe(400);
    expect((await ops.post(`/deployments/${id}/decommission`, { reason: 'x', confirmCode: before.code })).status).toBe(400);
    // RBAC: deployments.write alone (Technical Administrator) is not enough; viewers and other organizations are refused.
    expect((await tech.post(`/deployments/${id}/decommission`, { reason: 'Site closed', confirmCode: before.code })).status).toBe(403);
    expect((await viewer.post(`/deployments/${id}/decommission`, { reason: 'Site closed', confirmCode: before.code })).status).toBe(403);
    expect((await orgB.post(`/deployments/${id}/decommission`, { reason: 'Site closed', confirmCode: before.code })).status).toBe(404);

    const r = await ops.post(`/deployments/${id}/decommission`, { reason: 'Site closed; contract ended', confirmCode: before.code.toLowerCase() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as DeploymentDetail;
    expect(d.lifecycleState).toBe('decommissioned');
    expect(d.decommission).toMatchObject({
      reason: 'Site closed; contract ended', by: expect.any(String), fromState: before.lifecycleState, metadataPurgedAt: null,
      identity: { certificatesRevoked: 1, tokensRevoked: 0, packagesRevoked: 0, commandsCancelled: 1 },
    });
    expect(new Date(d.decommission!.retainedUntil).getTime() - new Date(d.decommission!.at).getTime()).toBe(90 * 86_400_000); // default retention
    expect(d.agentCertificates[0]).toMatchObject({ status: 'revoked', revokeReason: 'Decommissioned: Site closed; contract ended' });
    expect(d.installationId).toBe(before.installationId); // identity history is kept
    expect(d.healthState).toBe('unknown');
    expect(d.suspension).toBeNull();
    expect(d.readiness.find((c) => c.key === 'state')).toMatchObject({ ok: false });
    // The open command was cancelled; the history keeps it.
    const ops1 = (await tech.get(`/deployments/${id}/operations?limit=50`)).body;
    expect(ops1.canIssue).toBe(false);
    expect(ops1.commands.find((c: { id: string }) => c.id === cmd.body.id).status).toBe('cancelled');

    // The gateway: every mTLS request answers 410 `decommissioned` (not `revoked`), and reports are refused.
    const hb = await heartbeat(a);
    expect(hb.status, JSON.stringify(hb.body)).toBe(410);
    expect(hb.body.error).toBe('decommissioned');
    expect((await reports(a)).status).toBe(410);
    const k = await keyAndCsr(a.en.installationId);
    expect((await gw(port, '/agent/v1/renew', { csr: k.csr }, a.en.caCertificate, a)).status).toBe(410);
    // Replaying the used enrollment token is refused with the decommissioning reason (audited).
    const replay = await gw(port, '/agent/v1/enroll', { token: a.en.token, deploymentId: a.en.deploymentId, installationId: a.en.installationId, csr: k.csr, agentVersion: '0.1.0' }, a.en.caCertificate);
    expect(replay.status).toBe(403);
    expect(replay.body.error).toBe('deployment-decommissioned');

    // Final: nothing can bring it back; no package, no command, no suspension, no settings change, no second decommissioning.
    expect((await ops.post(`/deployments/${id}/decommission`, { reason: 'again', confirmCode: before.code })).status).toBe(409);
    expect((await ops.post(`/deployments/${id}/resume`, { reason: 'back' })).status).toBe(409);
    expect((await ops.post(`/deployments/${id}/suspend`, { reason: 'pause' })).status).toBe(409);
    expect((await ops.post(`/deployments/${id}/packages`, { tokenValidityHours: 1 })).status).toBe(422);
    expect((await tech.post(`/deployments/${id}/commands`, { type: 'refresh_health' })).status).toBe(409);
    expect((await ops.post(`/deployments/${id}/agent-certificate/revoke`, { reason: 'already retired' })).status).toBe(409);
    // Health: unknown, with the single lifecycle finding; the fleet view no longer lists it.
    const h = (await ops.get(`/deployments/${id}/health`)).body;
    expect(h.healthState).toBe('unknown');
    expect(h.findings.map((f: { code: string }) => f.code)).toEqual(['deployment_decommissioned']);
    expect((await ops.get('/monitoring/fleet')).body.rows.some((x: { id: string }) => x.id === id)).toBe(false);
    // Lists and stats: filterable by the final state.
    const list = (await ops.get('/deployments?lifecycle=decommissioned&pageSize=100')).body;
    expect(list.items.map((x: { id: string }) => x.id)).toContain(id);
    expect((await ops.get('/deployments/stats')).body.decommissioned).toBeGreaterThanOrEqual(1);
    // Audit: one event with the summary of what was retired.
    const ev = (await activity(id)).find((e) => e.action === 'deployment.decommissioned')!;
    expect(ev.metadata).toMatchObject({ reason: 'Site closed; contract ended', lifecycleFrom: before.lifecycleState, lifecycleTo: 'decommissioned', identity: { certificatesRevoked: 1, commandsCancelled: 1 } });
    expect((await activity(id)).map((e) => e.action)).toEqual(expect.arrayContaining(['agent.enrollment.rejected']));
  });

  it('frees the license slot and works from suspended and from draft (revoking the unused token and package)', async () => {
    const a = await enrolledAgent(app, ops, port);
    const id = a.en.deploymentId;
    const lic = (await detail(id)).licenseDetail!;
    const usedBefore = (await ops.get(`/licenses/${lic.id}`)).body.deploymentsUsed as number;
    expect((await ops.post(`/deployments/${id}/suspend`, { reason: 'Paused first' })).status).toBe(200);
    const r = await ops.post(`/deployments/${id}/decommission`, { reason: 'Never came back', confirmCode: a.en.deploymentCode });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.decommission, JSON.stringify(r.body.decommission)).toMatchObject({ fromState: 'enrolled' }); // the state it was suspended from, not "suspended"
    expect(r.body.decommission.identity.commandsCancelled).toBe(1); // the pending signed suspend command
    expect((await ops.get(`/licenses/${lic.id}`)).body.deploymentsUsed).toBe(usedBefore - 1);
    // Draft with a usable package: the token and the package are revoked, the archive is purged.
    const en = await packageFor(app, ops);
    const r2 = await ops.post(`/deployments/${en.deploymentId}/decommission`, { reason: 'Project cancelled before installation', confirmCode: en.deploymentCode });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.decommission, JSON.stringify(r2.body.decommission)).toMatchObject({ fromState: 'package_downloaded', identity: { certificatesRevoked: 0, tokensRevoked: 1, packagesRevoked: 1, commandsCancelled: 0 } });
    expect(r2.body.packages[0]).toMatchObject({ status: 'revoked', downloadable: false });
    expect(r2.body.packages[0].token.status).toBe('revoked');
    const k = await keyAndCsr(en.installationId);
    const enroll = await gw(port, '/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: k.csr, agentVersion: '0.1.0' }, en.caCertificate);
    expect(enroll.status).toBe(403);
    expect(enroll.body.error).toBe('deployment-decommissioned');
  });

  it('refuses synthetic records', async () => {
    const synthetic = (await ops.get('/deployments?pageSize=100')).body.items.find((x: { isSynthetic: boolean; lifecycleState: string }) => x.isSynthetic && x.lifecycleState !== 'decommissioned');
    expect((await ops.post(`/deployments/${synthetic.id}/decommission`, { reason: 'try', confirmCode: synthetic.code })).status).toBe(409);
  });
});

describe('retention policy and purge', () => {
  it('has a default, is per organization, validated, audited, and shows statistics', async () => {
    const p = (await ops.get('/settings/retention')).body as RetentionPolicyDto;
    expect(p).toMatchObject({ decommissionedMetadataDays: 90, updatedAt: null, updatedBy: null });
    expect(p.stats.decommissioned).toBeGreaterThanOrEqual(1);
    expect((await ops.put('/settings/retention', { decommissionedMetadataDays: 3 })).status).toBe(400);
    expect((await ops.put('/settings/retention', { decommissionedMetadataDays: 30, extra: 1 })).status).toBe(400);
    expect((await viewer.put('/settings/retention', { decommissionedMetadataDays: 30 })).status).toBe(403);
    expect((await viewer.get('/settings/retention')).status).toBe(403); // reading needs settings.read, which Read Only does not hold
    const r = await ops.put('/settings/retention', { decommissionedMetadataDays: 30 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ decommissionedMetadataDays: 30, updatedBy: expect.any(String) });
    expect((await orgB.get('/settings/retention')).body.decommissionedMetadataDays).toBe(90);
    const audit = (await admin.get('/audit-events?targetType=retention_policy&pageSize=10')).body.items as { action: string; metadata: Record<string, unknown> }[];
    expect(audit[0]).toMatchObject({ action: 'retention_policy.updated', metadata: { decommissionedMetadataDays: { from: 90, to: 30 } } });
    // A deployment decommissioned today is retained until +30 days under the new policy.
    const d = (await ops.get('/deployments?lifecycle=decommissioned&pageSize=100')).body.items.find((x: { isSynthetic: boolean }) => !x.isSynthetic);
    const dd = await detail(d.id);
    expect(new Date(dd.decommission!.retainedUntil).getTime() - new Date(dd.decommission!.at).getTime()).toBe(30 * 86_400_000);
  });

  it('purges only metadata whose retention period ended, audits each purge, and keeps the record and the audit trail', async () => {
    const a = await enrolledAgent(app, ops, port);
    const id = a.en.deploymentId;
    expect((await reports(a)).status).toBe(200);
    await tech.post(`/deployments/${id}/commands`, { type: 'refresh_health' });
    expect((await ops.post(`/deployments/${id}/decommission`, { reason: 'Retention test', confirmCode: a.en.deploymentCode })).status).toBe(200);
    expect((await ops.put('/settings/retention', { decommissionedMetadataDays: 30 })).status).toBe(200);
    const purgeNothing = await ops.post('/settings/retention/purge');
    expect(purgeNothing.status).toBe(200);
    expect(purgeNothing.body.purgedDeployments).toBe(0); // decommissioned just now: nothing is due
    expect((await detail(id)).decommission!.metadataPurgedAt).toBeNull();
    // Pretend the deployment was decommissioned 40 days ago (policy: 30 days).
    await asAppCommit({ orgId: orgA, scopeAll: true }, (c) => c.query(`UPDATE deployments SET decommissioned_at = now() - interval '40 days' WHERE id = $1`, [id]));
    expect((await app.get(RetentionService).sweep())).toBeGreaterThanOrEqual(1);
    const after = await detail(id);
    expect(after.lifecycleState).toBe('decommissioned');
    expect(after.decommission!.metadataPurgedAt).not.toBeNull();
    expect(after.agentCertificates.length).toBe(1); // identity history stays
    const rows = await asAppCommit({ orgId: orgA, scopeAll: true }, async (c) => ({
      reports: Number((await c.query('SELECT count(*) FROM deployment_reports WHERE deployment_id = $1', [id])).rows[0].count),
      heartbeats: Number((await c.query('SELECT count(*) FROM deployment_heartbeats WHERE deployment_id = $1', [id])).rows[0].count),
      commands: Number((await c.query('SELECT count(*) FROM remote_commands WHERE deployment_id = $1', [id])).rows[0].count),
      audit: Number((await c.query(`SELECT count(*) FROM audit_events WHERE target_id = $1`, [id])).rows[0].count),
    }));
    expect(rows).toMatchObject({ reports: 0, heartbeats: 0, commands: 0 });
    expect(rows.audit).toBeGreaterThan(2);
    const purged = (await activity(id)).find((e) => e.action === 'deployment.metadata.purged')!;
    expect(purged.metadata).toMatchObject({ retentionDays: 30, deleted: { reports: expect.any(Number), commands: 1 } });
    expect((await ops.get('/settings/retention')).body.stats.purged).toBeGreaterThanOrEqual(1);
    expect((await ops.get(`/deployments/${id}/health`)).body.findings.map((f: { code: string }) => f.code)).toEqual(['deployment_decommissioned']);
  });
});

describe('removal of a decommissioned record', () => {
  it('needs a decommissioned deployment, the typed code and the permission; deletes the record and its data; the audit trail and the gateway refusal stay', async () => {
    const live = await enrolledAgent(app, ops, port);
    expect((await ops.del(`/deployments/${live.en.deploymentId}`, { confirmCode: live.en.deploymentCode })).status).toBe(409); // not decommissioned
    const a = await enrolledAgent(app, ops, port);
    const id = a.en.deploymentId;
    expect((await reports(a)).status).toBe(200);
    expect((await ops.post(`/deployments/${id}/decommission`, { reason: 'Removal test', confirmCode: a.en.deploymentCode })).status).toBe(200);
    expect((await ops.del(`/deployments/${id}`, { confirmCode: 'DEP-00000' })).status).toBe(400);
    expect((await tech.del(`/deployments/${id}`, { confirmCode: a.en.deploymentCode })).status).toBe(403);
    expect((await orgB.del(`/deployments/${id}`, { confirmCode: a.en.deploymentCode })).status).toBe(404);
    const clientId = (await detail(id)).client.id;
    const r = await ops.del(`/deployments/${id}`, { confirmCode: a.en.deploymentCode });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id, code: a.en.deploymentCode, deleted: { deployments: 1, certificates: 1, packages: 1, enrollmentTokens: 1 } });
    expect(r.body.deleted.reports).toBeGreaterThan(0);
    expect((await ops.get(`/deployments/${id}`)).status).toBe(404);
    expect((await ops.get(`/deployments/${id}/health`)).status).toBe(404);
    // The retired certificate is simply unknown to the gateway now: still refused.
    const hb = await heartbeat(a);
    expect(hb.status).toBe(401);
    expect(hb.body.error).toBe('unknown');
    // The audit trail survives on the client's activity (the deployment itself is gone).
    const clientActivity = (await ops.get(`/clients/${clientId}/activity?pageSize=50`)).body.items as { action: string; targetId: string; metadata: Record<string, unknown> }[];
    const removed = clientActivity.find((e) => e.action === 'deployment.removed' && e.targetId === id)!;
    expect(removed.metadata).toMatchObject({ code: a.en.deploymentCode, deleted: { deployments: 1 } });
    expect(clientActivity.some((e) => e.action === 'deployment.decommissioned' && e.targetId === id)).toBe(true);
    expect(clientActivity.some((e) => e.action === 'agent.enrolled' && e.targetId === id)).toBe(true);
  });
});
