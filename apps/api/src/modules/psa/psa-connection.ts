import type { PsaApplianceStatus, PsaConnectionTestDto, ReportPayload } from '@psacc/contracts';
import type { Queryable } from '../../database/database.service.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * PSA connection status as reported by appliances (Module 11).
 *
 * The Control Plane never calls a PSA. Everything here derives from the agent's `psa_integration_status`
 * report: the appliance ran the real authentication / API test and sent only the outcome (codes, HTTP
 * status, latency, non-secret identity). The instance's `connection_status` / `credential_status` are a
 * projection of that report; `psa_instances_verified_requires_test` guarantees "succeeded" always
 * carries the time of a real success.
 */

type Row = Record<string, unknown>;
type Payload = ReportPayload<'psa_integration_status'>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);

function credentialStatusFor(p: Payload): 'not_configured' | 'configured' | 'invalid' {
  if (p.status === 'not_configured') return 'not_configured';
  if (p.status === 'failed' && (p.lastTestCode === 'auth_failed' || p.lastTestCode === 'forbidden')) return 'invalid';
  return 'configured';
}

function connectionStatusFor(p: Payload): 'untested' | 'succeeded' | 'failed' {
  if (p.status === 'verified') return 'succeeded';
  if (p.status === 'failed') return 'failed';
  return 'untested';
}

/**
 * Projects an appliance report onto the PSA instance the deployment is bound to. Ignored when the
 * deployment has no instance or the report names a different instance code. Audits status changes.
 */
export async function applyPsaReport(q: Queryable, audit: AuditService, input: { orgId: string; deploymentId: string; payload: Payload; observedAt: string }): Promise<void> {
  const { payload: p } = input;
  const r = await q.maybeOne<Row>(
    `SELECT d.code AS dep_code, d.client_id, i.id AS instance_id, i.code AS instance_code, i.display_name, i.connection_status, i.credential_status, i.last_successful_test_at
     FROM deployments d JOIN psa_instances i ON i.id = d.psa_instance_id WHERE d.id = $1 FOR UPDATE OF i`,
    [input.deploymentId],
  );
  if (!r || r.instance_code !== p.instanceCode) return;
  const connection = connectionStatusFor(p);
  const credential = credentialStatusFor(p);
  const successAt = connection === 'succeeded' ? (p.lastSuccessAt ?? p.lastTestAt ?? input.observedAt) : null;
  // Audit metadata keys avoid the word "credential": the audit reader masks such keys as secrets, and these are statuses.
  const before = { connectionStatus: r.connection_status as string, authStatus: r.credential_status as string };
  const unchanged = before.connectionStatus === connection && before.authStatus === credential && (connection !== 'succeeded' || iso(r.last_successful_test_at) === new Date(successAt!).toISOString());
  if (unchanged) return;
  await q.query(
    `UPDATE psa_instances SET connection_status = $2, credential_status = $3,
       last_successful_test_at = CASE WHEN $4::timestamptz IS NOT NULL THEN $4::timestamptz ELSE last_successful_test_at END
     WHERE id = $1`,
    [r.instance_id, connection, credential, successAt],
  );
  if (before.connectionStatus !== connection || before.authStatus !== credential) {
    await audit.write(q, {
      orgId: input.orgId, action: 'psa_instance.connection.reported', outcome: connection === 'failed' ? 'failure' : 'success', actorType: 'agent',
      actorDisplay: `Appliance ${r.dep_code as string}`, targetType: 'psa_instance', targetId: r.instance_id as string, targetDisplay: r.display_name as string,
      clientId: r.client_id as string,
      metadata: {
        deployment: r.dep_code, from: before, to: { connectionStatus: connection, authStatus: credential },
        code: p.lastTestCode ?? p.lastTestResult ?? null, httpStatus: p.lastTestHttpStatus ?? null, latencyMs: p.lastTestLatencyMs ?? null,
        testedBy: p.lastTestedBy ?? null, testedAt: p.lastTestAt ?? null, remoteIdentity: p.remoteIdentity ?? {},
      },
    });
  }
}

type SyncPayload = ReportPayload<'synchronization'>;

/**
 * Projects the appliance's `synchronization` report onto the instance's `last_sync_at` (the time of the
 * last successful run any of its appliances reported). Counts stay in the report store (Module 12).
 */
export async function applySyncReport(q: Queryable, input: { deploymentId: string; payload: SyncPayload }): Promise<void> {
  const at = input.payload.lastSucceededAt ?? (input.payload.lastStatus === 'succeeded' ? input.payload.lastRunAt : null);
  if (!at) return;
  await q.query(
    `UPDATE psa_instances i SET last_sync_at = GREATEST(coalesce(i.last_sync_at, 'epoch'::timestamptz), $2::timestamptz)
     FROM deployments d WHERE d.id = $1 AND i.id = d.psa_instance_id`,
    [input.deploymentId, at],
  );
}
type TicketPayload = ReportPayload<'ticket_processing_metrics'>;

function applianceFromRow(r: Row, sync: SyncPayload | undefined, tickets: TicketPayload | undefined): PsaApplianceStatus {
  const p = r.payload as Payload;
  return {
    sync: sync
      ? {
          implemented: sync.implemented ?? false, lastRunAt: sync.lastRunAt, lastStatus: sync.lastStatus, lastSucceededAt: sync.lastSucceededAt ?? null,
          itemsReceived: sync.itemsReceived, itemsSent: sync.itemsSent, itemsFailed: sync.itemsFailed, errorCode: sync.errorCode,
          runsLast24h: sync.runsLast24h ?? null, failedRunsLast24h: sync.failedRunsLast24h ?? null,
        }
      : null,
    tickets: tickets
      ? { total: tickets.ticketsTotal, open: tickets.ticketsOpen, pendingOutbound: tickets.pendingOutbound ?? null, conflictsLast24h: tickets.conflictsLast24h ?? null, lastProcessedAt: tickets.lastProcessedAt }
      : null,
    deployment: { id: r.deployment_id as string, code: r.dep_code as string, lifecycleState: r.lifecycle_state as string, healthState: r.health_state as string },
    status: p.status, credentialFields: p.credentialFields, credentialsPresent: p.credentialsPresent, apiCallsImplemented: p.apiCallsImplemented,
    lastTestAt: p.lastTestAt ?? null, lastTestCode: p.lastTestCode ?? p.lastTestResult ?? null, lastTestHttpStatus: p.lastTestHttpStatus ?? null,
    lastTestLatencyMs: p.lastTestLatencyMs ?? null, lastTestedBy: p.lastTestedBy ?? null, lastSuccessAt: p.lastSuccessAt ?? null,
    remoteIdentity: p.remoteIdentity ?? {}, consecutiveFailures: p.consecutiveFailures ?? 0, reportedAt: iso(r.received_at)!,
  };
}

/** Latest appliance report per PSA instance (the most recently received among the instance's deployments). */
export async function applianceStatuses(q: Queryable, instanceIds: string[]): Promise<Map<string, PsaApplianceStatus>> {
  const out = new Map<string, PsaApplianceStatus>();
  if (!instanceIds.length) return out;
  const rows = await q.query<Row>(
    `SELECT DISTINCT ON (d.psa_instance_id) d.psa_instance_id, d.id AS deployment_id, d.code AS dep_code, d.lifecycle_state, d.health_state, l.payload, l.received_at
     FROM deployment_report_latest l JOIN deployments d ON d.id = l.deployment_id
     WHERE l.report_type = 'psa_integration_status' AND d.psa_instance_id = ANY($1::uuid[]) AND d.lifecycle_state <> 'decommissioned'
     ORDER BY d.psa_instance_id, l.received_at DESC`,
    [instanceIds],
  );
  if (!rows.length) return out;
  const extra = await q.query<Row>(
    `SELECT deployment_id, report_type, payload FROM deployment_report_latest WHERE deployment_id = ANY($1::uuid[]) AND report_type IN ('synchronization', 'ticket_processing_metrics')`,
    [rows.map((r) => r.deployment_id as string)],
  );
  const byDep = new Map<string, { sync?: SyncPayload; tickets?: TicketPayload }>();
  for (const e of extra) {
    const cur = byDep.get(e.deployment_id as string) ?? {};
    if (e.report_type === 'synchronization') cur.sync = e.payload as SyncPayload;
    else cur.tickets = e.payload as TicketPayload;
    byDep.set(e.deployment_id as string, cur);
  }
  for (const r of rows) {
    const p = r.payload as Payload;
    if (!p || typeof p !== 'object') continue;
    const x = byDep.get(r.deployment_id as string) ?? {};
    out.set(r.psa_instance_id as string, applianceFromRow(r, x.sync, x.tickets));
  }
  return out;
}

/** Distinct connection tests reported for an instance (one row per test time), newest first. */
export async function connectionTests(q: Queryable, instanceId: string, limit: number): Promise<PsaConnectionTestDto[]> {
  const rows = await q.query<Row>(
    `SELECT DISTINCT ON (r.payload->>'lastTestAt') r.payload, r.received_at, d.id AS deployment_id, d.code AS dep_code
     FROM deployment_reports r JOIN deployments d ON d.id = r.deployment_id
     WHERE d.psa_instance_id = $1 AND r.report_type = 'psa_integration_status' AND r.payload->>'lastTestAt' IS NOT NULL
     ORDER BY r.payload->>'lastTestAt' DESC, r.received_at ASC LIMIT $2`,
    [instanceId, limit],
  );
  return rows.map((r) => {
    const p = r.payload as Payload;
    const code = p.lastTestCode ?? p.lastTestResult ?? (p.status === 'verified' ? 'ok' : 'failed');
    return {
      testedAt: p.lastTestAt!, testedBy: p.lastTestedBy ?? null, ok: p.status === 'verified' || code === 'ok', code,
      httpStatus: p.lastTestHttpStatus ?? null, latencyMs: p.lastTestLatencyMs ?? null, remoteIdentity: p.remoteIdentity ?? {},
      deployment: { id: r.deployment_id as string, code: r.dep_code as string }, reportedAt: iso(r.received_at)!,
    };
  });
}
