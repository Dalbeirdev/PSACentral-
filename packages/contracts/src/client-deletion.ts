import { z } from 'zod';

/**
 * Module 17 — Client-initiated deletion from the appliance ("Delete all data and deregister").
 *
 * The client's local administrator can end the service from the appliance itself: everything the
 * appliance holds (tickets, PSA credentials, logs, backups, identity) is deleted on the host, and the
 * Control Plane deletes everything it holds about that deployment in the same way as an explicit
 * removal (Module 15), without waiting for decommissioning or a retention period. The only thing the
 * Control Plane keeps is the audit event that records the deletion. The request travels over the
 * appliance's own mutual-TLS identity; nothing is ever triggered remotely by the Control Plane.
 */

/** What the agent sends to `POST /agent/v1/delete` (authenticated by its machine certificate). */
export const clientDeletionRequestSchema = z.strictObject({
  /** The installation the certificate was issued for; it must match the certificate's binding. */
  installationId: z.uuid(),
  /** The local administrator who confirmed the deletion on the appliance (a user name, never a password). */
  requestedBy: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(500).default(''),
  requestedAt: z.iso.datetime({ offset: true }),
});
export type ClientDeletionRequest = z.infer<typeof clientDeletionRequestSchema>;

/** The gateway's answer: the record is gone, or it was already gone (a retried request). */
export const clientDeletionResultSchema = z.strictObject({
  status: z.enum(['deleted', 'already-deleted']),
  deploymentCode: z.string(),
  deletedAt: z.iso.datetime({ offset: true }),
  /** The audit event that is the only trace left on the Control Plane. */
  auditEventId: z.uuid().nullable(),
  /** Rows deleted per table (empty for an already-deleted deployment). */
  deleted: z.record(z.string(), z.number().int().nonnegative()),
});
export type ClientDeletionResult = z.infer<typeof clientDeletionResultSchema>;

export const CLIENT_DELETION_AUDIT_ACTION = 'deployment.deleted_by_client';

/** The appliance's own progress, as the agent writes it for the local admin page and `edge-agent status`. */
export const APPLIANCE_DELETION_PHASES = ['requested', 'deregistering', 'deregistered', 'wiping', 'wiped', 'refused'] as const;
export type ApplianceDeletionPhase = (typeof APPLIANCE_DELETION_PHASES)[number];

export const APPLIANCE_DELETION_PHASE_LABELS: Record<ApplianceDeletionPhase, string> = {
  requested: 'Deletion requested',
  deregistering: 'Deregistering from the Control Plane',
  deregistered: 'Deregistered; deleting local data',
  wiping: 'Deleting local data',
  wiped: 'All data deleted',
  refused: 'The Control Plane refused the deregistration',
};

export const applianceDeletionStatusSchema = z.strictObject({
  phase: z.enum(APPLIANCE_DELETION_PHASES),
  requestedAt: z.iso.datetime({ offset: true }),
  requestedBy: z.string(),
  reason: z.string().default(''),
  attempts: z.number().int().nonnegative(),
  lastAttemptAt: z.iso.datetime({ offset: true }).nullable(),
  lastError: z.string().default(''),
  /** True once the Control Plane confirmed the deletion of its records. */
  controlPlaneNotified: z.boolean(),
  deregisteredAt: z.iso.datetime({ offset: true }).nullable(),
  wipedAt: z.iso.datetime({ offset: true }).nullable(),
  /** What was deleted on the appliance (rows per table) and what the host operator still removes. */
  deleted: z.record(z.string(), z.number().int().nonnegative()).default({}),
  remaining: z.array(z.string()).default([]),
  /** What the Control Plane reported it deleted, and the audit event that remains there. */
  controlPlaneDeleted: z.record(z.string(), z.number().int().nonnegative()).default({}),
  auditEventId: z.string().nullable().default(null),
});
export type ApplianceDeletionStatus = z.infer<typeof applianceDeletionStatusSchema>;
