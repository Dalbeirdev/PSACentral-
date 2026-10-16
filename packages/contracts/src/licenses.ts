import { z } from 'zod';
import type { DeploymentLifecycleState, HealthState } from './common.js';

/**
 * Licensing, suspension and lifecycle (Module 14). A license is a per-client entitlement with its own
 * identifier (LIC-xxxxx), a plan name, a term and a maximum number of deployments. Deployments bind to a
 * license; packages are generated and agents enroll only under an active license. Suspension is a
 * reversible lifecycle step: the appliance keeps its data and local UI, PSA work pauses.
 */

export const LICENSE_STATUSES = ['active', 'suspended', 'expired', 'revoked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];
export const LICENSE_STATUS_LABELS: Record<LicenseStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  expired: 'Expired',
  revoked: 'Revoked',
};

/** Days before the end date at which a license counts as expiring. */
export const LICENSE_EXPIRING_DAYS = 30;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD).');
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(200);

const termFields = {
  displayName: z.string().trim().min(2, 'Give the license a plan name (at least 2 characters).').max(120),
  startsAt: ymd,
  endsAt: ymd.nullable(),
  maxDeployments: z.number().int().min(1).max(1000),
  notes: z.string().trim().max(2000).optional(),
};
const termRule = (v: { startsAt: string; endsAt: string | null }) => v.endsAt === null || v.endsAt >= v.startsAt;
const termMessage = { message: 'The end date must not be before the start date.', path: ['endsAt'] };

export const licenseCreateSchema = z.strictObject({ clientId: z.uuid({ error: 'Choose a client.' }), ...termFields }).refine(termRule, termMessage);
export type LicenseCreate = z.infer<typeof licenseCreateSchema>;

export const licenseUpdateSchema = z.strictObject({ version: z.number().int().min(1), ...termFields }).refine(termRule, termMessage);
export type LicenseUpdate = z.infer<typeof licenseUpdateSchema>;

export const licenseActionSchema = z.strictObject({ reason });
export type LicenseAction = z.infer<typeof licenseActionSchema>;

export const licenseListQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  status: z.enum(LICENSE_STATUSES).optional(),
  clientId: z.uuid().optional(),
  /** Only licenses whose end date falls within this many days (or already passed). */
  expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['code', '-code', 'client', '-client', 'endsAt', '-endsAt', 'status', '-status']).default('endsAt'),
});
export type LicenseListQuery = z.infer<typeof licenseListQuerySchema>;

export interface LicenseSummary {
  id: string;
  code: string;
  client: { id: string; code: string; displayName: string };
  displayName: string;
  status: LicenseStatus;
  startsAt: string;
  endsAt: string | null;
  /** Days until the end date (negative when passed); null for perpetual licenses. */
  daysRemaining: number | null;
  expiring: boolean;
  maxDeployments: number;
  /** Deployments bound to the license that are not decommissioned. */
  deploymentsUsed: number;
  createdAt: string;
  updatedAt: string;
  isSynthetic: boolean;
}

export interface LicenseDeploymentRow {
  id: string;
  code: string;
  lifecycleState: DeploymentLifecycleState;
  healthState: HealthState;
  hostLabel: string | null;
  suspendedAt: string | null;
}

export interface LicenseDetail extends LicenseSummary {
  notes: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  version: number;
  deployments: LicenseDeploymentRow[];
}

export type LicenseStats = Record<LicenseStatus, number> & { total: number; expiring: number };

/** Suspension of a deployment: reversible, audited, delivered to the appliance as a signed command. */
export const deploymentSuspendSchema = z.strictObject({ reason });
export type DeploymentSuspend = z.infer<typeof deploymentSuspendSchema>;

export interface DeploymentLicenseInfo {
  id: string;
  code: string;
  displayName: string;
  status: LicenseStatus;
  endsAt: string | null;
  daysRemaining: number | null;
}

export interface DeploymentSuspension {
  at: string;
  reason: string;
  fromState: DeploymentLifecycleState;
  by: string | null;
}
