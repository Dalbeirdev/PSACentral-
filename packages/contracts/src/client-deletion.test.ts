import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_DELETION_PHASES,
  APPLIANCE_DELETION_PHASE_LABELS,
  CLIENT_DELETION_AUDIT_ACTION,
  applianceDeletionStatusSchema,
  clientDeletionRequestSchema,
  clientDeletionResultSchema,
} from './client-deletion.js';

const INST = '7c5b4d0e-2f1a-4b3c-8d9e-0f1a2b3c4d5e';

describe('client-initiated deletion contracts (Module 17)', () => {
  it('accepts a well-formed request and defaults the reason', () => {
    const r = clientDeletionRequestSchema.parse({ installationId: INST, requestedBy: 'localadmin', requestedAt: '2026-10-16T10:00:00Z' });
    expect(r.reason).toBe('');
  });

  it('refuses unknown fields, bad ids and over-long text (strict)', () => {
    expect(clientDeletionRequestSchema.safeParse({ installationId: INST, requestedBy: 'x', requestedAt: '2026-10-16T10:00:00Z', password: 'no' }).success).toBe(false);
    expect(clientDeletionRequestSchema.safeParse({ installationId: 'not-a-uuid', requestedBy: 'x', requestedAt: '2026-10-16T10:00:00Z' }).success).toBe(false);
    expect(clientDeletionRequestSchema.safeParse({ installationId: INST, requestedBy: '', requestedAt: '2026-10-16T10:00:00Z' }).success).toBe(false);
    expect(clientDeletionRequestSchema.safeParse({ installationId: INST, requestedBy: 'x', reason: 'r'.repeat(501), requestedAt: '2026-10-16T10:00:00Z' }).success).toBe(false);
    expect(clientDeletionRequestSchema.safeParse({ installationId: INST, requestedBy: 'x', requestedAt: 'yesterday' }).success).toBe(false);
  });

  it('describes the result with per-table counts', () => {
    const r = clientDeletionResultSchema.parse({ status: 'deleted', deploymentCode: 'DEP-00042', deletedAt: '2026-10-16T10:00:01Z', auditEventId: INST, deleted: { deployments: 1, reports: 12 } });
    expect(r.deleted.reports).toBe(12);
    expect(clientDeletionResultSchema.safeParse({ status: 'gone', deploymentCode: 'DEP-00042', deletedAt: '2026-10-16T10:00:01Z', auditEventId: null, deleted: {} }).success).toBe(false);
    expect(clientDeletionResultSchema.safeParse({ status: 'deleted', deploymentCode: 'DEP-00042', deletedAt: '2026-10-16T10:00:01Z', auditEventId: null, deleted: { reports: -1 } }).success).toBe(false);
  });

  it('labels every appliance phase and names the audit action', () => {
    for (const p of APPLIANCE_DELETION_PHASES) expect(APPLIANCE_DELETION_PHASE_LABELS[p].length).toBeGreaterThan(5);
    expect(CLIENT_DELETION_AUDIT_ACTION).toBe('deployment.deleted_by_client');
    const s = applianceDeletionStatusSchema.parse({ phase: 'wiped', requestedAt: '2026-10-16T10:00:00Z', requestedBy: 'localadmin', attempts: 1, lastAttemptAt: null, controlPlaneNotified: true, deregisteredAt: '2026-10-16T10:00:01Z', wipedAt: '2026-10-16T10:00:02Z' });
    expect(s.remaining).toEqual([]);
    expect(applianceDeletionStatusSchema.safeParse({ ...s, phase: 'done' }).success).toBe(false);
  });
});
