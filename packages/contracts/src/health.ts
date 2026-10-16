import { z } from 'zod';
import { type HealthState, HEALTH_STATES } from './common.js';

/**
 * Agent reports (ARCHITECTURE §1.1.3). Every report is a strict schema of enums, numbers, versions,
 * identifiers and sanitized error codes: unknown fields are rejected by the gateway, so there is
 * nowhere to put ticket content or credentials. The agent reports only what it actually measures;
 * a value it cannot measure is null, never invented.
 */

const code = z.string().regex(/^[a-z0-9_.-]{1,64}$/);
const shortText = z.string().max(200);
const version = z.string().max(40).regex(/^[0-9A-Za-z.+_-]+$/);
const nonNeg = z.number().int().min(0);
const percent = z.number().min(0).max(100);
const iso = z.iso.datetime({ offset: true });

export const databaseReportSchema = z.strictObject({
  available: z.boolean(),
  databaseName: z.string().max(64).optional(),
  serverVersion: z.string().max(40).optional(),
  schemaVersion: z.string().regex(/^\d{4}$/).optional(),
  migrationsApplied: nonNeg,
  lastMigratedAt: iso.nullable().optional(),
  sizeBytes: nonNeg,
  tables: z
    .array(
      z.strictObject({
        schema: z.string().max(64),
        name: z.string().max(64),
        /** PostgreSQL's catalog estimate; null until the table was analysed. Never an exact count. */
        estimatedRows: nonNeg.nullable(),
        sizeBytes: nonNeg,
        columns: nonNeg,
        hasPrimaryKey: z.boolean(),
        indexes: nonNeg,
        foreignKeys: nonNeg,
      }),
    )
    .max(500),
  error: code.optional(),
});

const ident = z.string().min(1).max(64);
/** Catalog DDL (index definitions, column defaults): printable ASCII only, bounded. Never a row value. */
const ddl = (max: number) => z.string().max(max).regex(/^[\x20-\x7e]*$/);

/**
 * Per-table schema metadata for the Database Explorer (Module 9), read from pg_catalog by the
 * inspector role. A snapshot is split into parts of at most 50 tables that share a fingerprint.
 */
export const tableSchemaSchema = z.strictObject({
  schema: ident,
  name: ident,
  kind: z.enum(['table', 'partitioned']),
  columns: z
    .array(z.strictObject({ position: z.number().int().min(1), name: ident, type: z.string().min(1).max(100), nullable: z.boolean(), default: ddl(200).nullable(), identity: z.boolean() }))
    .max(300),
  primaryKey: z.strictObject({ name: ident, columns: z.array(ident).min(1).max(32) }).nullable(),
  indexes: z.array(z.strictObject({ name: ident, unique: z.boolean(), primary: z.boolean(), definition: ddl(500), sizeBytes: nonNeg })).max(100),
  foreignKeys: z
    .array(
      z.strictObject({
        name: ident,
        columns: z.array(ident).min(1).max(32),
        referencedSchema: ident,
        referencedTable: ident,
        referencedColumns: z.array(ident).min(1).max(32),
        onDelete: z.enum(['no_action', 'restrict', 'cascade', 'set_null', 'set_default']),
      }),
    )
    .max(100),
  /** Row-count metadata: planner estimates and statistics, never a count the inspector could not run. */
  stats: z.strictObject({
    estimatedRows: nonNeg.nullable(),
    liveRows: nonNeg.nullable(),
    deadRows: nonNeg.nullable(),
    lastAnalyzeAt: iso.nullable(),
    lastAutoanalyzeAt: iso.nullable(),
    lastVacuumAt: iso.nullable(),
    lastAutovacuumAt: iso.nullable(),
    totalBytes: nonNeg,
    tableBytes: nonNeg,
    indexBytes: nonNeg,
    toastBytes: nonNeg,
  }),
});
export type TableSchema = z.infer<typeof tableSchemaSchema>;

export const databaseSchemaReportSchema = z
  .strictObject({
    /** Derived by the agent from the inventory (schema version, tables, column/index/key counts). */
    fingerprint: z.string().regex(/^[0-9a-f]{32}$/),
    part: z.number().int().min(1).max(100),
    parts: z.number().int().min(1).max(100),
    tables: z.array(tableSchemaSchema).max(50),
  })
  .refine((r) => r.part <= r.parts, { path: ['part'], message: 'part must not exceed parts' });

export const hostResourcesReportSchema = z.strictObject({
  cpuPercent: percent.nullable(),
  memoryUsedBytes: nonNeg.nullable(),
  memoryLimitBytes: nonNeg.nullable(),
  diskUsedBytes: nonNeg.nullable(),
  diskTotalBytes: nonNeg.nullable(),
  /** Mount point the disk figures were measured on (the Docker data volume file system). */
  diskMount: z.string().max(100).nullable(),
  uptimeSeconds: nonNeg.nullable(),
  cpuCount: nonNeg.nullable(),
});

/** Service checks the agent can actually perform from inside the deployment (it has no Docker socket). */
export const containersReportSchema = z.strictObject({
  services: z
    .array(
      z.strictObject({
        name: z.enum(['edge-postgres', 'edge-api', 'edge-worker', 'edge-backup', 'edge-agent']),
        probe: z.enum(['database', 'http', 'liveness', 'self']),
        state: z.enum(['up', 'down', 'stale', 'unknown']),
        detail: code.optional(),
        lastSeenAt: iso.nullable().optional(),
      }),
    )
    .max(10),
});

/** Stable result codes of the appliance-side PSA connection test (Module 11). */
export const PSA_TEST_CODES = ['ok', 'auth_failed', 'forbidden', 'not_found', 'rate_limited', 'server_error', 'bad_response', 'endpoint_unreachable', 'tls_error', 'timeout', 'not_configured', 'unsupported', 'invalid_config'] as const;
export type PsaTestCode = (typeof PSA_TEST_CODES)[number];
export const PSA_TEST_CODE_LABELS: Record<PsaTestCode, string> = {
  ok: 'Succeeded', auth_failed: 'Authentication rejected', forbidden: 'Permission denied', not_found: 'API path not found', rate_limited: 'Rate limited',
  server_error: 'PSA server error', bad_response: 'Unexpected response', endpoint_unreachable: 'Endpoint unreachable', tls_error: 'TLS error', timeout: 'Timed out',
  not_configured: 'Credentials missing', unsupported: 'Adapter not available', invalid_config: 'Invalid configuration',
};

export const psaIntegrationReportSchema = z.strictObject({
  provider: z.string().max(40),
  instanceCode: z.string().regex(/^PSA-\d{5,}$/),
  status: z.enum(['not_configured', 'credentials_present', 'verified', 'failed']),
  credentialFields: nonNeg,
  credentialsPresent: nonNeg,
  lastTestAt: iso.nullable(),
  lastTestResult: code.nullable(),
  /** False for appliances built before Module 11 (no PSA API calls); true when real connection tests run. */
  apiCallsImplemented: z.boolean(),
  // Module 11 — outcome of the last real connection test run on the appliance (metadata only).
  lastTestCode: z.enum(PSA_TEST_CODES).nullable().optional(),
  lastTestHttpStatus: z.number().int().min(100).max(599).nullable().optional(),
  lastTestLatencyMs: nonNeg.nullable().optional(),
  lastTestedBy: z.enum(['local_admin', 'worker', 'remote']).nullable().optional(),
  lastSuccessAt: iso.nullable().optional(),
  /** Non-secret facts about the remote API (name, host, company/tenant/table). */
  remoteIdentity: z.record(z.string().max(40), z.string().max(200)).optional(),
  consecutiveFailures: nonNeg.optional(),
  testsLast24h: nonNeg.optional(),
  failedTestsLast24h: nonNeg.optional(),
});


export const ticketMetricsReportSchema = z.strictObject({
  ticketsTotal: nonNeg,
  ticketsOpen: nonNeg,
  eventsLast24h: nonNeg,
  failedLast24h: nonNeg,
  lastProcessedAt: iso.nullable(),
  // Module 12 — synchronization bookkeeping (counts only).
  pendingOutbound: nonNeg.optional(),
  conflictsLast24h: nonNeg.optional(),
  localOnly: nonNeg.optional(),
  pushFailed: nonNeg.optional(),
});

export const synchronizationReportSchema = z.strictObject({
  lastRunAt: iso.nullable(),
  lastStatus: z.enum(['running', 'succeeded', 'failed', 'partial']).nullable(),
  itemsReceived: nonNeg,
  itemsSent: nonNeg,
  itemsFailed: nonNeg,
  errorCode: code.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  /** Recent sanitized integration errors (codes, components, redacted messages). */
  recentErrors: z
    .array(z.strictObject({ at: iso, component: z.enum(['migrate', 'api', 'worker', 'agent', 'backup']), code: code.nullable(), httpStatus: z.number().int().min(100).max(599).nullable(), message: shortText }))
    .max(20),
  errorsLast24h: nonNeg,
  // Module 12 — present once the appliance runs the synchronization engine.
  implemented: z.boolean().optional(),
  lastSucceededAt: iso.nullable().optional(),
  runsLast24h: nonNeg.optional(),
  failedRunsLast24h: nonNeg.optional(),
  watermark: iso.nullable().optional(),
});

export const versionsReportSchema = z.strictObject({
  agent: version,
  image: version,
  application: version,
  schema: z.string().regex(/^\d{4}$/).nullable(),
  postgres: z.string().max(40).nullable(),
});

export const backupReportSchema = z.strictObject({
  lastStatus: z.enum(['succeeded', 'failed', 'running', 'none']),
  lastAt: iso.nullable(),
  lastSizeBytes: nonNeg.nullable(),
  retained: nonNeg,
  lastError: shortText.nullable(),
});

export const certificatesSecurityReportSchema = z.strictObject({
  certificateSerial: z.string().regex(/^[0-9a-f]{32}$/),
  certificateNotAfter: iso,
  daysRemaining: z.number().int().min(-36500).max(36500),
  localAdminFailedLogins24h: nonNeg,
  localAdminLocked: z.boolean(),
  /** The agent cannot confirm host disk encryption from inside a container. */
  encryptedDiskConfirmed: z.boolean().nullable(),
});

export const REPORT_SCHEMAS = {
  database: databaseReportSchema,
  database_schema: databaseSchemaReportSchema,
  host_resources: hostResourcesReportSchema,
  containers: containersReportSchema,
  psa_integration_status: psaIntegrationReportSchema,
  ticket_processing_metrics: ticketMetricsReportSchema,
  synchronization: synchronizationReportSchema,
  versions: versionsReportSchema,
  backup: backupReportSchema,
  certificates_security: certificatesSecurityReportSchema,
} as const;
export type ReportType = keyof typeof REPORT_SCHEMAS;
export type ReportPayload<T extends ReportType> = z.infer<(typeof REPORT_SCHEMAS)[T]>;

/** One report as sent by the agent. */
export const agentReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.enum(Object.keys(REPORT_SCHEMAS) as [ReportType, ...ReportType[]]),
  observedAt: iso,
  payload: z.record(z.string(), z.unknown()),
});
export const agentReportBatchSchema = z.strictObject({
  agentVersion: version,
  reports: z.array(agentReportSchema).min(1).max(50),
});

/** Centrally configured health policy (per organization). */
export const healthPolicySchema = z.strictObject({
  heartbeatIntervalSeconds: z.number().int().min(15).max(3600),
  offlineAfterSeconds: z.number().int().min(30).max(86_400),
  staleReportAfterSeconds: z.number().int().min(60).max(86_400),
  cpuWarnPercent: percent,
  cpuCriticalPercent: percent,
  memoryWarnPercent: percent,
  memoryCriticalPercent: percent,
  diskWarnPercent: percent,
  diskCriticalPercent: percent,
  backupMaxAgeHours: z.number().int().min(1).max(8760),
  certificateWarnDays: z.number().int().min(1).max(365),
}).superRefine((p, ctx) => {
  const pairs: [keyof typeof p, keyof typeof p][] = [['cpuWarnPercent', 'cpuCriticalPercent'], ['memoryWarnPercent', 'memoryCriticalPercent'], ['diskWarnPercent', 'diskCriticalPercent']];
  for (const [warn, crit] of pairs) if ((p[warn] as number) >= (p[crit] as number)) ctx.addIssue({ code: 'custom', path: [crit], message: 'The critical threshold must be above the warning threshold.' });
  if (p.offlineAfterSeconds < p.heartbeatIntervalSeconds * 2) ctx.addIssue({ code: 'custom', path: ['offlineAfterSeconds'], message: 'Allow at least two heartbeat intervals before a deployment counts as offline.' });
});
export type HealthPolicy = z.infer<typeof healthPolicySchema>;
export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  heartbeatIntervalSeconds: 60,
  offlineAfterSeconds: 300,
  staleReportAfterSeconds: 900,
  cpuWarnPercent: 80,
  cpuCriticalPercent: 95,
  memoryWarnPercent: 80,
  memoryCriticalPercent: 95,
  diskWarnPercent: 80,
  diskCriticalPercent: 95,
  backupMaxAgeHours: 48,
  certificateWarnDays: 14,
};

export interface HealthFinding {
  /** Stable code for the finding, e.g. `database_unavailable`, `disk_warn`. */
  code: string;
  severity: 'critical' | 'degraded' | 'info';
  message: string;
}

export interface HealthEvaluation {
  state: HealthState;
  reason: string | null;
  findings: HealthFinding[];
  evaluatedAt: string;
}

export interface LatestReport<T extends ReportType = ReportType> {
  type: T;
  observedAt: string;
  receivedAt: string;
  payload: ReportPayload<T>;
}

export interface DeploymentHealthDto {
  deploymentId: string;
  code: string;
  client: { id: string; code: string; displayName: string };
  isSynthetic: boolean;
  lifecycleState: string;
  healthState: HealthState;
  healthReason: string | null;
  findings: HealthFinding[];
  evaluatedAt: string | null;
  lastHeartbeatAt: string | null;
  enrolledAt: string | null;
  verifiedAt: string | null;
  agentVersion: string | null;
  policy: HealthPolicy;
  latest: Partial<{ [T in ReportType]: LatestReport<T> }>;
  /** Host resource samples, oldest first (last 24 h). */
  resourceHistory: { observedAt: string; cpuPercent: number | null; memoryPercent: number | null; diskPercent: number | null }[];
  /** Heartbeats received, newest first (last 50). */
  heartbeats: { receivedAt: string; agentVersion: string | null }[];
  /** Health state changes, newest first (last 30 days). */
  events: { healthState: HealthState; reason: string | null; source: 'agent' | 'system' | 'synthetic'; observedAt: string }[];
}

export interface FleetHealthRow {
  id: string;
  code: string;
  client: { id: string; code: string; displayName: string };
  isSynthetic: boolean;
  lifecycleState: string;
  healthState: HealthState;
  healthReason: string | null;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  databaseAvailable: boolean | null;
  lastReportAt: string | null;
}

export interface FleetHealthDto {
  generatedAt: string;
  policy: HealthPolicy;
  summary: Record<HealthState, number>;
  /** Of the summary, how many are synthetic sample records. */
  syntheticSummary: Record<HealthState, number>;
  rows: FleetHealthRow[];
}

export const fleetHealthQuerySchema = z.strictObject({
  state: z.enum(HEALTH_STATES).optional(),
  q: z.string().trim().max(100).optional(),
  live: z.enum(['1']).optional(),
});
