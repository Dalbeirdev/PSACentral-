import { describe, expect, it } from 'vitest';
import {
  COMMAND_OPEN_STATUSES, COMMAND_STATUS_LABELS, COMMAND_STATUSES, COMMAND_TYPE_INFO, COMMAND_TYPES, OPERATOR_COMMAND_TYPES,
  canonicalCommand, commandIssueSchema, commandParamsSchemas, commandResultSchema,
} from './commands.js';

describe('remote commands (Module 13)', () => {
  it('every type and status has a label; the type list is non-destructive by construction', () => {
    for (const t of COMMAND_TYPES) expect(COMMAND_TYPE_INFO[t].label.length).toBeGreaterThan(3);
    for (const s of COMMAND_STATUSES) expect(COMMAND_STATUS_LABELS[s].length).toBeGreaterThan(3);
    expect(COMMAND_OPEN_STATUSES).toEqual(['pending', 'delivered', 'staged']);
    for (const t of ['revoke', 'decommission', 'uninstall', 'wipe', 'shell']) expect(COMMAND_TYPES as readonly string[]).not.toContain(t);
    // Suspend / resume (Module 14) are reversible lifecycle commands issued by the deployment lifecycle, never from the Operations cards.
    for (const t of ['suspend', 'resume'] as const) {
      expect(COMMAND_TYPE_INFO[t].lifecycleOnly).toBe(true);
      expect(OPERATOR_COMMAND_TYPES as readonly string[]).not.toContain(t);
    }
    expect(OPERATOR_COMMAND_TYPES).toHaveLength(6);
  });

  it('validates the issue request and the per-type parameters', () => {
    expect(commandIssueSchema.parse({ type: 'refresh_health' })).toEqual({ type: 'refresh_health', expiresInMinutes: 60 });
    expect(commandIssueSchema.safeParse({ type: 'refresh_health', expiresInMinutes: 7 }).success).toBe(false);
    expect(commandIssueSchema.safeParse({ type: 'format_disk' }).success).toBe(false);
    expect(commandIssueSchema.safeParse({ type: 'refresh_health', note: 'x'.repeat(201) }).success).toBe(false);
    expect(commandParamsSchemas.restart_service.safeParse({ service: 'edge-postgres' }).success).toBe(false);
    expect(commandParamsSchemas.restart_service.safeParse({ service: 'edge-worker' }).success).toBe(true);
    expect(commandParamsSchemas.refresh_health.safeParse({ extra: 1 }).success).toBe(false);
    expect(commandParamsSchemas.upgrade.safeParse({ repository: 'psacc/psa-edge', version: '0.2.0', digest: null }).success).toBe(true);
    expect(commandParamsSchemas.upgrade.safeParse({ repository: 'Evil Repo', version: '0.2.0', digest: null }).success).toBe(false);
    expect(commandParamsSchemas.upgrade.safeParse({ repository: 'psacc/psa-edge', version: 'latest', digest: null }).success).toBe(false);
  });

  it('the canonical form is deterministic: fixed key order, sorted params, no whitespace (the agent builds the same bytes)', () => {
    const a = canonicalCommand({ id: 'id', type: 'restart_service', deploymentId: 'd', installationId: 'i', params: { service: 'edge-api', b: 1, a: true, n: null, h: '<&>' }, issuedAt: 't1', expiresAt: 't2', keyId: 'k' });
    const b = canonicalCommand({ keyId: 'k', expiresAt: 't2', issuedAt: 't1', params: { h: '<&>', n: null, a: true, b: 1, service: 'edge-api' }, installationId: 'i', deploymentId: 'd', type: 'restart_service', id: 'id' });
    expect(a).toBe(b);
    expect(a).toBe('{"id":"id","type":"restart_service","deploymentId":"d","installationId":"i","params":{"a":true,"b":1,"h":"<&>","n":null,"service":"edge-api"},"issuedAt":"t1","expiresAt":"t2","keyId":"k"}');
  });

  it('results carry a stable code, bounded message and the agent version', () => {
    const ok = { commandId: '6f1f0c0a-5b1e-4a7a-9b4e-0c2f0b7b1d11', status: 'succeeded', code: 'reports_delivered', message: 'done', startedAt: '2026-10-15T10:00:00.000Z', finishedAt: '2026-10-15T10:00:01.000Z', agentVersion: '0.1.0' };
    expect(commandResultSchema.safeParse(ok).success).toBe(true);
    expect(commandResultSchema.safeParse({ ...ok, status: 'exploded' }).success).toBe(false);
    expect(commandResultSchema.safeParse({ ...ok, code: 'Not a code' }).success).toBe(false);
    expect(commandResultSchema.safeParse({ ...ok, message: 'x'.repeat(501) }).success).toBe(false);
    expect(commandResultSchema.safeParse({ ...ok, extra: true }).success).toBe(false);
  });
});
