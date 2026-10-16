import { z } from 'zod';

/**
 * Remote commands (Module 13). The Control Plane never connects into a client network (AD-1): a
 * command is a signed, time-limited instruction that the deployment's agent pulls with its heartbeat,
 * verifies against the Control Plane's command-signing public key pinned at enrollment, executes if
 * the type is allow-listed, and answers with a result over its mTLS channel. Every command has an ID,
 * an issuer, a target, a status, timestamps, an expiry and an audit record on both sides.
 *
 * Nothing here is destructive: suspension, revocation, decommissioning and uninstall are Modules 14
 * and 15 and are not command types in this version.
 */

export const COMMAND_TYPES = ['refresh_health', 'test_psa_connection', 'run_sync', 'restart_service', 'rotate_certificate', 'upgrade', 'suspend', 'resume'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** Services the agent may ask to restart. Each one exits cleanly and Compose (`restart: unless-stopped`) starts it again. */
export const RESTARTABLE_SERVICES = ['edge-api', 'edge-worker', 'edge-agent'] as const;
export type RestartableService = (typeof RESTARTABLE_SERVICES)[number];

export interface CommandTypeInfo {
  label: string;
  description: string;
  /** What the operator sees while the command waits for the appliance. */
  runsOn: 'agent' | 'worker' | 'api' | 'host operator';
  /** Issued by the deployment lifecycle (suspend / resume, Module 14), not from the Operations cards. */
  lifecycleOnly?: boolean;
}

/** The command types an operator can issue directly from the Operations tab. */
export const OPERATOR_COMMAND_TYPES = ['refresh_health', 'test_psa_connection', 'run_sync', 'restart_service', 'rotate_certificate', 'upgrade'] as const satisfies readonly CommandType[];

export const COMMAND_TYPE_INFO: Record<CommandType, CommandTypeInfo> = {
  refresh_health: { label: 'Refresh health now', description: 'The agent collects and delivers a fresh set of reports immediately instead of waiting for its interval.', runsOn: 'agent' },
  test_psa_connection: { label: 'Test PSA connection', description: 'The worker runs the real connection test on the appliance; only the outcome (code, HTTP status, latency) is reported.', runsOn: 'worker' },
  run_sync: { label: 'Run synchronization', description: 'The worker runs one ticket synchronization pass now (the connection must be verified).', runsOn: 'worker' },
  restart_service: { label: 'Restart a service', description: 'The chosen service exits cleanly and Docker Compose starts it again. In-flight work is finished or retried; no data is lost.', runsOn: 'agent' },
  rotate_certificate: { label: 'Rotate machine certificate', description: 'The agent generates a new key and certificate request; the gateway issues a new certificate and retires the old one.', runsOn: 'agent' },
  upgrade: { label: 'Upgrade appliance image', description: 'The agent verifies and stages the signed upgrade order on the appliance. The host operator applies it with scripts/upgrade.sh (the appliance has no Docker socket by design); the agent reports success once the new version runs.', runsOn: 'host operator' },
  suspend: { label: 'Suspend (lifecycle)', description: 'The worker pauses PSA connection tests and ticket synchronization and the local UI shows the suspension. Tickets, data and the local admin stay available; nothing is deleted.', runsOn: 'worker', lifecycleOnly: true },
  resume: { label: 'Resume (lifecycle)', description: 'The worker resumes PSA tests and synchronization.', runsOn: 'worker', lifecycleOnly: true },
};

export const COMMAND_STATUSES = ['pending', 'delivered', 'staged', 'succeeded', 'failed', 'expired', 'cancelled'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];
export const COMMAND_STATUS_LABELS: Record<CommandStatus, string> = {
  pending: 'Waiting for the agent',
  delivered: 'Delivered — running on the appliance',
  staged: 'Staged — waiting for the host operator',
  succeeded: 'Succeeded',
  failed: 'Failed',
  expired: 'Expired before completion',
  cancelled: 'Cancelled',
};
/** Statuses that still wait for something. */
export const COMMAND_OPEN_STATUSES = ['pending', 'delivered', 'staged'] as const satisfies readonly CommandStatus[];

/** Validity window the issuer may choose (minutes). */
export const COMMAND_EXPIRY_MINUTES = [15, 60, 240, 1440] as const;

export const commandParamsSchemas = {
  refresh_health: z.strictObject({}),
  test_psa_connection: z.strictObject({}),
  run_sync: z.strictObject({}),
  restart_service: z.strictObject({ service: z.enum(RESTARTABLE_SERVICES) }),
  rotate_certificate: z.strictObject({}),
  upgrade: z.strictObject({
    repository: z.string().regex(/^[a-z0-9]+([._/-][a-z0-9]+)*$/),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  }),
  suspend: z.strictObject({ reason: z.string().trim().min(3).max(200) }),
  resume: z.strictObject({}),
} as const;
export type CommandParams<T extends CommandType = CommandType> = z.infer<(typeof commandParamsSchemas)[T]>;

/** Issue request. Parameters are validated per type; the upgrade target is set by the Control Plane, not the request. */
export const commandIssueSchema = z.strictObject({
  type: z.enum(COMMAND_TYPES),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  expiresInMinutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.literal(1440)]).default(60),
  /** Optional operator note, kept with the audit record. */
  note: z.string().trim().max(200).optional(),
});
export type CommandIssue = z.infer<typeof commandIssueSchema>;

export const commandListQuerySchema = z.strictObject({
  status: z.enum(COMMAND_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** What the agent receives inside a heartbeat response. `signature` is Ed25519 over `canonicalCommand()` of the rest. */
export interface SignedCommand {
  id: string;
  type: CommandType;
  deploymentId: string;
  installationId: string;
  params: Record<string, string | number | boolean | null>;
  issuedAt: string;
  expiresAt: string;
  /** Identifies the signing key, so a rotated key can be recognised. */
  keyId: string;
  signature: string;
}

/**
 * The exact bytes that are signed: a JSON object with these keys in this order and no whitespace.
 * The agent builds the same string in Go; keep both in step.
 */
export function canonicalCommand(c: Omit<SignedCommand, 'signature'>): string {
  const params = Object.fromEntries(Object.keys(c.params).sort().map((k) => [k, c.params[k]]));
  return JSON.stringify({ id: c.id, type: c.type, deploymentId: c.deploymentId, installationId: c.installationId, params, issuedAt: c.issuedAt, expiresAt: c.expiresAt, keyId: c.keyId });
}

/** The agent's answer (mTLS, `POST /agent/v1/command-results`). */
export const commandResultSchema = z.strictObject({
  commandId: z.uuid(),
  status: z.enum(['succeeded', 'failed', 'staged']),
  code: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
  message: z.string().max(500),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  agentVersion: z.string().max(40).regex(/^[0-9A-Za-z.+_-]+$/),
});
export type CommandResult = z.infer<typeof commandResultSchema>;

/** A remote command as the dashboard sees it. */
export interface RemoteCommandDto {
  id: string;
  type: CommandType;
  params: Record<string, string | number | boolean | null>;
  status: CommandStatus;
  issuedBy: string | null;
  note: string | null;
  issuedAt: string;
  expiresAt: string;
  deliveredAt: string | null;
  finishedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  result: { code: string; message: string; startedAt: string; agentVersion: string } | null;
  keyId: string;
}

/** What the Operations page needs besides the history. */
export interface RemoteOperationsDto {
  deploymentId: string;
  /** Commands can only be issued to an enrolled appliance. */
  canIssue: boolean;
  reason: string | null;
  /** The standard image the Control Plane would upgrade to, and what the appliance runs. */
  upgradeTarget: { repository: string; version: string; digest: string | null };
  runningVersion: string | null;
  upToDate: boolean;
  /** Types with an open command (one open command per type per deployment). */
  open: Partial<Record<CommandType, string>>;
  signingKeyId: string;
  commands: RemoteCommandDto[];
}
