import { z } from 'zod';
import { listQuerySchema } from './common.js';

export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const auditQuerySchema = listQuerySchema.extend({
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  action: z.string().trim().max(100).regex(/^[a-z0-9_.*]*$/).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** Events about one record (e.g. a license or deployment). */
  targetType: z.string().trim().max(64).regex(/^[a-z_]*$/).optional(),
  targetId: z.string().trim().max(128).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditEventDto {
  id: string;
  occurredAt: string;
  actorType: 'user' | 'system' | 'agent';
  actorUserId: string | null;
  actorDisplay: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetDisplay: string | null;
  outcome: AuditOutcome;
  ip: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}
