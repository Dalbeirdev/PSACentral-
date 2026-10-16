import { z } from 'zod';
import type { DeploymentLifecycleState } from './common.js';

/**
 * Module 15 — Secure decommissioning and deployment removal.
 *
 * Decommissioning is a Control Plane decision: it retires the deployment's management identity (the
 * machine certificate, enrollment tokens, packages and open commands) and records why. Nothing on the
 * client's host is touched remotely: the appliance learns that its identity was retired, stops its PSA
 * work and shows the removal instructions; tickets, data and the local admin stay on the host until the
 * host operator runs the uninstall script. Metadata the Control Plane holds about a decommissioned
 * deployment is kept for the organization's retention period, then purged; the record itself can be
 * removed explicitly afterwards. The audit trail is never deleted.
 */
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(200);
/** The operator types the deployment code to confirm (DEP-00042); compared case-insensitively. */
const confirmCode = z.string().trim().min(1, 'Type the deployment ID to confirm.').max(20);

export const deploymentDecommissionSchema = z.strictObject({ reason, confirmCode });
export type DeploymentDecommission = z.infer<typeof deploymentDecommissionSchema>;

export const deploymentRemoveSchema = z.strictObject({ confirmCode });
export type DeploymentRemove = z.infer<typeof deploymentRemoveSchema>;

/** What decommissioning retired, as counted inside the same transaction. */
export interface DecommissionIdentitySummary {
  certificatesRevoked: number;
  tokensRevoked: number;
  packagesRevoked: number;
  commandsCancelled: number;
}

export interface DeploymentDecommissionInfo {
  at: string;
  reason: string;
  by: string | null;
  /** The lifecycle state the deployment had before (a suspended deployment reports the state it was suspended from). */
  fromState: DeploymentLifecycleState;
  identity: DecommissionIdentitySummary;
  /** When the retained operational metadata (reports, heartbeats, inventory, commands) is or was purged. */
  retainedUntil: string;
  metadataPurgedAt: string | null;
}

export interface DeploymentRemovalResult {
  id: string;
  code: string;
  removedAt: string;
  /** Rows deleted per table, for the audit record and the confirmation page. */
  deleted: Record<string, number>;
}

/** Organization-wide retention policy for decommissioned deployments. */
export const RETENTION_DAYS_MIN = 7;
export const RETENTION_DAYS_MAX = 3650;
export const retentionPolicySchema = z.strictObject({
  decommissionedMetadataDays: z.number({ error: 'Enter the number of days.' }).int().min(RETENTION_DAYS_MIN, `At least ${RETENTION_DAYS_MIN} days.`).max(RETENTION_DAYS_MAX, `At most ${RETENTION_DAYS_MAX} days.`),
});
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { decommissionedMetadataDays: 90 };

export interface RetentionPolicyDto extends RetentionPolicy {
  updatedAt: string | null;
  updatedBy: string | null;
  /** Decommissioned deployments still holding metadata, those already purged, and the next purge due (null when nothing is due). */
  stats: { decommissioned: number; awaitingPurge: number; purged: number; nextPurgeAt: string | null };
}

export interface RetentionPurgeResult {
  purgedDeployments: number;
  ranAt: string;
}
