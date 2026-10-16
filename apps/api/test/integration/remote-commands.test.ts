import type { NestExpressApplication } from '@nestjs/platform-express';
import { COMMAND_TYPES, type RemoteOperationsDto, type SignedCommand } from '@psacc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { CommandsService } from '../../src/modules/deployments/commands.service.js';
import { type AgentIdentity, enrolledAgent, gw, healthyReports } from './agent-helpers.js';
import { type Client, EMAIL, asApp, asAppCommit, ids, signedIn, startApp } from './helpers.js';

/**
 * Module 13 — Remote management. Commands are issued by authorized users, signed with the Control
 * Plane's Ed25519 key, pulled by the deployment's agent with its heartbeat, verified (the tests verify
 * with the public key the enrollment response delivered), answered over mTLS, audited, and expired by
 * the sweep. Nothing destructive exists as a command type.
 */
let app: NestExpressApplication;
let port: number;
let ops: Client;
let tech: Client;
let viewer: Client;
let orgB: Client;
beforeAll(async () => {
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '100' });
  const g = app.get(AgentGateway);
  await g.start(0, '127.0.0.1');
  port = g.address!.port;
  ops = await signedIn(app, EMAIL.ops);
  tech = await signedIn(app, EMAIL.tech);
  viewer = await signedIn(app, EMAIL.viewer);
  orgB = await signedIn(app, EMAIL.orgB);
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

const heartbeat = (a: AgentIdentity) => gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a);
const result = (a: AgentIdentity, body: Record<string, unknown>) =>
  gw(port, '/agent/v1/command-results', { status: 'succeeded', code: 'ok', message: 'done', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), agentVersion: '0.1.0', ...body }, a.en.caCertificate, a);
const operations = async (c: Client, id: string) => (await c.get(`/deployments/${id}/operations`)).body as RemoteOperationsDto;

describe('remote commands', () => {
  it('a command is signed, pulled with the heartbeat (delivered), answered over mTLS (succeeded) and audited at every step', async () => {
    const a = await enrolledAgent(app, ops, port);
    const dep = a.en.deploymentId;
    const before = await operations(tech, dep);
    expect(before).toMatchObject({ canIssue: true, reason: null, runningVersion: null, upToDate: false, commands: [] });
    expect(before.signingKeyId).toMatch(/^[0-9a-f]{16}$/);

    const issued = await tech.post(`/deployments/${dep}/commands`, { type: 'refresh_health', note: 'Check after maintenance' });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.body).toMatchObject({ type: 'refresh_health', status: 'pending', issuedBy: EMAIL.tech, note: 'Check after maintenance', params: {}, deliveredAt: null, result: null });
    expect(new Date(issued.body.expiresAt).getTime() - new Date(issued.body.issuedAt).getTime()).toBe(60 * 60_000);
    // One open command per type.
    const dup = await tech.post(`/deployments/${dep}/commands`, { type: 'refresh_health' });
    expect(dup.status).toBe(409);
    expect(dup.body.type).toBe('urn:psacc:problem:command-open');

    // The agent's heartbeat carries the command with a signature that verifies against the enrollment-time key.
    const hb = await heartbeat(a);
    expect(hb.status).toBe(200);
    const cmds = hb.body.commands as SignedCommand[];
    expect(cmds).toHaveLength(1);
    const key = hb.body.commandSigningKey as { keyId: string; publicKeyPem: string };
    expect(key.keyId).toBe(before.signingKeyId);
    expect(key.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(cmds[0]).toMatchObject({ id: issued.body.id, type: 'refresh_health', deploymentId: dep, installationId: a.en.installationId, keyId: key.keyId });
    expect(CommandsService.verify(cmds[0]!, key.publicKeyPem)).toBe(true);
    expect(CommandsService.verify({ ...cmds[0]!, type: 'rotate_certificate' }, key.publicKeyPem)).toBe(false);
    expect((await operations(tech, dep)).commands[0]).toMatchObject({ status: 'delivered' });
    expect((await operations(tech, dep)).commands[0]!.deliveredAt).not.toBeNull();
    // Re-fetch while still open: the gateway hands it over again (the agent dedupes), without re-marking.
    expect(((await heartbeat(a)).body.commands as unknown[]).length).toBe(1);

    const done = await result(a, { commandId: issued.body.id, code: 'reports_delivered', message: '1 batch delivered' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const after = await operations(tech, dep);
    expect(after.commands[0]).toMatchObject({ status: 'succeeded', result: { code: 'reports_delivered', message: '1 batch delivered', agentVersion: '0.1.0' } });
    expect(after.commands[0]!.finishedAt).not.toBeNull();
    expect(after.open).toEqual({});
    expect(((await heartbeat(a)).body.commands as unknown[]).length).toBe(0);
    // A second result for a closed command is refused.
    expect((await result(a, { commandId: issued.body.id })).status).toBe(409);
    // Audit: issued by the user, completed by the agent actor.
    const activity = (await tech.get(`/deployments/${dep}/activity?pageSize=20`)).body.items as { action: string; actorType: string; metadata: Record<string, unknown> }[];
    expect(activity.map((e) => e.action)).toEqual(expect.arrayContaining(['deployment.command.issued', 'deployment.command.completed']));
    expect(activity.find((e) => e.action === 'deployment.command.completed')).toMatchObject({ actorType: 'agent', metadata: { commandId: issued.body.id, status: 'succeeded', code: 'reports_delivered' } });
  });

  it('parameters are validated per type, the upgrade target comes from the Control Plane, and an up-to-date appliance is refused', async () => {
    const a = await enrolledAgent(app, ops, port);
    const dep = a.en.deploymentId;
    const bad = await tech.post(`/deployments/${dep}/commands`, { type: 'restart_service', params: { service: 'edge-postgres' } });
    expect(bad.status).toBe(400);
    const missing = await tech.post(`/deployments/${dep}/commands`, { type: 'restart_service' });
    expect(missing.status).toBe(400);
    const unknownType = await tech.post(`/deployments/${dep}/commands`, { type: 'wipe_disk' });
    expect(unknownType.status).toBe(400);
    const ok = await tech.post(`/deployments/${dep}/commands`, { type: 'restart_service', params: { service: 'edge-worker' }, expiresInMinutes: 15 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.params).toEqual({ service: 'edge-worker' });
    // Upgrade: the target is the configured standard image, not caller input.
    const up = await tech.post(`/deployments/${dep}/commands`, { type: 'upgrade', params: { repository: 'evil/image', version: '9.9.9' } });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.params).toMatchObject({ repository: 'psacc/psa-edge', version: '0.1.0' });
    // Once the appliance reports that version, another upgrade to it is refused.
    const staged = await result(a, { commandId: up.body.id, status: 'staged', code: 'staged', message: 'Run scripts/upgrade.sh' });
    expect(staged.status).toBe(200);
    expect((await operations(tech, dep)).commands.find((c) => c.id === up.body.id)).toMatchObject({ status: 'staged' });
    const applied = await result(a, { commandId: up.body.id, code: 'upgraded', message: 'now 0.1.0' });
    expect(applied.status).toBe(200);
    const reports = await gw(port, '/agent/v1/reports', healthyReports({ versions: { agent: '0.1.0', image: '0.1.0', application: '0.1.0', schema: '0004', postgres: '17.6' } }), a.en.caCertificate, a);
    expect(reports.status).toBe(200);
    const o = await operations(tech, dep);
    expect(o).toMatchObject({ runningVersion: '0.1.0', upToDate: true });
    const again = await tech.post(`/deployments/${dep}/commands`, { type: 'upgrade' });
    expect(again.status).toBe(409);
    expect(again.body.type).toBe('urn:psacc:problem:already-up-to-date');
  });

  it('only pending commands can be cancelled; expired ones are closed by the sweep and never delivered', async () => {
    const a = await enrolledAgent(app, ops, port);
    const dep = a.en.deploymentId;
    const c = (await tech.post(`/deployments/${dep}/commands`, { type: 'run_sync' })).body;
    const cancelled = await tech.post(`/deployments/${dep}/commands/${c.id}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelledBy: EMAIL.tech });
    expect(((await heartbeat(a)).body.commands as unknown[]).length).toBe(0);
    expect((await tech.post(`/deployments/${dep}/commands/${c.id}/cancel`)).status).toBe(409);

    const e = (await tech.post(`/deployments/${dep}/commands`, { type: 'test_psa_connection' })).body;
    const { orgA } = await ids();
    await asAppCommit({ orgId: orgA, scopeAll: true }, (q) => q.query(`UPDATE remote_commands SET issued_at = clock_timestamp() - interval '3 minutes', expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1`, [e.id]));
    expect(((await heartbeat(a)).body.commands as unknown[]).length).toBe(0); // expired commands are not handed out
    expect(await app.get(CommandsService).sweepExpired()).toBeGreaterThanOrEqual(1);
    expect((await operations(tech, dep)).commands.find((x) => x.id === e.id)).toMatchObject({ status: 'expired' });
    expect((await result(a, { commandId: e.id })).status).toBe(409); // a late result does not revive it
    const audit = await asApp({ orgId: orgA, scopeAll: true }, async (q) => (await q.query(`SELECT count(*)::text AS n FROM audit_events WHERE action = 'deployment.command.expired' AND metadata->>'commandId' = $1`, [e.id])).rows[0].n as string);
    expect(audit).toBe('1');
    // The type can be issued again once the earlier command is closed.
    expect((await tech.post(`/deployments/${dep}/commands`, { type: 'test_psa_connection' })).status).toBe(201);
  });

  it('RBAC, isolation and identity: viewers read, only commands.issue holders issue, another organization sees nothing, another appliance cannot answer', async () => {
    const a = await enrolledAgent(app, ops, port);
    const b = await enrolledAgent(app, ops, port);
    const dep = a.en.deploymentId;
    const c = (await tech.post(`/deployments/${dep}/commands`, { type: 'rotate_certificate' })).body;
    expect((await viewer.get(`/deployments/${dep}/operations`)).status).toBe(200);
    expect((await viewer.post(`/deployments/${dep}/commands`, { type: 'refresh_health' })).status).toBe(403);
    expect((await ops.post(`/deployments/${dep}/commands`, { type: 'refresh_health' })).status).toBe(403); // ops admin has no commands.issue
    expect((await orgB.get(`/deployments/${dep}/operations`)).status).toBe(404);
    expect((await orgB.post(`/deployments/${dep}/commands`, { type: 'refresh_health' })).status).toBe(404);
    // Appliance B neither receives A's command nor can answer it.
    expect(((await heartbeat(b)).body.commands as unknown[]).length).toBe(0);
    const stolen = await result(b, { commandId: c.id });
    expect(stolen.status).toBe(404);
    expect((await operations(tech, dep)).commands[0]).toMatchObject({ id: c.id, status: 'pending' });
    // No certificate at all: refused before any lookup.
    const anon = await gw(port, '/agent/v1/command-results', { commandId: c.id, status: 'succeeded', code: 'ok', message: '', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), agentVersion: '0.1.0' }, a.en.caCertificate);
    expect(anon.status).toBe(401);
    // A malformed result is rejected.
    expect((await result(a, { commandId: c.id, status: 'exploded' })).status).toBe(400);
    expect((await result(a, { commandId: c.id, code: 'Not A Code!' })).status).toBe(400);
  });

  it('commands cannot be issued before enrollment or to synthetic records, and every type is non-destructive by construction', async () => {
    const { orgA } = await ids();
    const draft = await asApp({ orgId: orgA, scopeAll: true }, async (q) => (await q.query(`SELECT id FROM deployments WHERE lifecycle_state = 'draft' AND is_synthetic = false LIMIT 1`)).rows[0]?.id as string | undefined);
    if (draft) {
      const o = await operations(tech, draft);
      expect(o.canIssue).toBe(false);
      expect(o.reason).toContain('enrolled');
      expect((await tech.post(`/deployments/${draft}/commands`, { type: 'refresh_health' })).status).toBe(409);
    }
    const synthetic = await asApp({ orgId: orgA, scopeAll: true }, async (q) => (await q.query(`SELECT id FROM deployments WHERE is_synthetic = true LIMIT 1`)).rows[0]?.id as string | undefined);
    if (synthetic) {
      expect((await operations(tech, synthetic)).canIssue).toBe(false);
      expect((await tech.post(`/deployments/${synthetic}/commands`, { type: 'refresh_health' })).status).toBe(409);
    }
    for (const t of ['revoke_access', 'decommission', 'uninstall', 'wipe']) expect(COMMAND_TYPES as readonly string[]).not.toContain(t);
  });
});
