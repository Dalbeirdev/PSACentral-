import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_HEALTH_POLICY,
  type DeploymentHealthDto,
  type FleetHealthDto,
  type FleetHealthRow,
  HEALTH_STATES,
  type HealthEvaluation,
  type HealthFinding,
  type HealthPolicy,
  type HealthState,
  type LatestReport,
  REPORT_SCHEMAS,
  type ReportPayload,
  type ReportType,
  agentReportBatchSchema,
} from '@psacc/contracts';
import type { z } from 'zod';
import type { AuthContext, RequestMeta, TenantContext } from '../../common/auth-context.js';
import { JsonLogger } from '../../common/logger.js';
import { AppError } from '../../common/problem.filter.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService, escapeLike } from '../audit/audit.service.js';
import { storeSchemaPart } from '../database-explorer/schema-store.js';
import { applyPsaReport, applySyncReport } from '../psa/psa-connection.js';
import { evaluateHealth, usage } from './rules.js';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const SWEEP_MS = 30_000;

function policyFromRow(r: Row | null): HealthPolicy {
  if (!r) return DEFAULT_HEALTH_POLICY;
  return {
    heartbeatIntervalSeconds: r.heartbeat_interval_seconds as number,
    offlineAfterSeconds: r.offline_after_seconds as number,
    staleReportAfterSeconds: r.stale_report_after_seconds as number,
    cpuWarnPercent: Number(r.cpu_warn_percent),
    cpuCriticalPercent: Number(r.cpu_critical_percent),
    memoryWarnPercent: Number(r.memory_warn_percent),
    memoryCriticalPercent: Number(r.memory_critical_percent),
    diskWarnPercent: Number(r.disk_warn_percent),
    diskCriticalPercent: Number(r.disk_critical_percent),
    backupMaxAgeHours: r.backup_max_age_hours as number,
    certificateWarnDays: r.certificate_warn_days as number,
  };
}

export interface IngestResult {
  accepted: number;
  rejected: { index: number; type: string; reason: string }[];
  evaluation: HealthEvaluation;
}

/**
 * Health monitoring: stores allow-listed agent reports, evaluates each deployment's state with the
 * rules engine against the organization's policy, records state changes, and marks a deployment
 * Verified after its first healthy evaluation. A periodic sweep detects offline agents.
 */
@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.logger.warn({ msg: 'Health sweep failed', err }, 'HealthService'));
    }, SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- policy ----

  async policyIn(q: Queryable, orgId: string): Promise<HealthPolicy> {
    return policyFromRow(await q.maybeOne<Row>('SELECT * FROM health_policies WHERE organization_id = $1', [orgId]));
  }

  async policy(auth: AuthContext): Promise<HealthPolicy> {
    return this.db.tenant(auth, (q) => this.policyIn(q, auth.orgId));
  }

  async updatePolicy(auth: AuthContext, p: HealthPolicy, meta: RequestMeta): Promise<HealthPolicy> {
    return this.db.tenant(auth, async (q) => {
      const before = await this.policyIn(q, auth.orgId);
      await q.query(
        `INSERT INTO health_policies (organization_id, heartbeat_interval_seconds, offline_after_seconds, stale_report_after_seconds, cpu_warn_percent, cpu_critical_percent,
           memory_warn_percent, memory_critical_percent, disk_warn_percent, disk_critical_percent, backup_max_age_hours, certificate_warn_days, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
         ON CONFLICT (organization_id) DO UPDATE SET heartbeat_interval_seconds = EXCLUDED.heartbeat_interval_seconds, offline_after_seconds = EXCLUDED.offline_after_seconds,
           stale_report_after_seconds = EXCLUDED.stale_report_after_seconds, cpu_warn_percent = EXCLUDED.cpu_warn_percent, cpu_critical_percent = EXCLUDED.cpu_critical_percent,
           memory_warn_percent = EXCLUDED.memory_warn_percent, memory_critical_percent = EXCLUDED.memory_critical_percent, disk_warn_percent = EXCLUDED.disk_warn_percent,
           disk_critical_percent = EXCLUDED.disk_critical_percent, backup_max_age_hours = EXCLUDED.backup_max_age_hours, certificate_warn_days = EXCLUDED.certificate_warn_days,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [auth.orgId, p.heartbeatIntervalSeconds, p.offlineAfterSeconds, p.staleReportAfterSeconds, p.cpuWarnPercent, p.cpuCriticalPercent, p.memoryWarnPercent,
          p.memoryCriticalPercent, p.diskWarnPercent, p.diskCriticalPercent, p.backupMaxAgeHours, p.certificateWarnDays, auth.userId],
      );
      const changes = Object.fromEntries(Object.entries(p).filter(([k, v]) => before[k as keyof HealthPolicy] !== v).map(([k, v]) => [k, { from: before[k as keyof HealthPolicy], to: v }]));
      if (Object.keys(changes).length) {
        const actor = (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
        await this.audit.write(q, { orgId: auth.orgId, action: 'health_policy.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: actor, meta, targetType: 'health_policy', targetId: auth.orgId, metadata: { changes } });
        // Thresholds changed: re-evaluate every live deployment now rather than at its next report.
        await this.evaluateAllIn(q, auth.orgId, 'system');
      }
      return this.policyIn(q, auth.orgId);
    });
  }

  // ---- ingestion (called by the gateway with the organization identified from the certificate) ----

  async ingest(orgId: string, deploymentId: string, installationId: string, body: unknown, ip: string | null): Promise<IngestResult> {
    const batch = agentReportBatchSchema.safeParse(body);
    if (!batch.success) throw new AppError(400, 'invalid-request', 'The report batch is malformed.');
    const ctx: TenantContext = { orgId, scopeAll: true };
    return this.db.tenant(ctx, async (q) => {
      const dep = await q.maybeOne<Row>(`SELECT id, code, client_id, installation_id, lifecycle_state, is_synthetic FROM deployments WHERE id = $1 FOR UPDATE`, [deploymentId]);
      if (!dep) throw new AppError(404, 'not-found', 'Deployment not found.');
      if (dep.installation_id !== installationId) throw new AppError(403, 'identity-mismatch', 'The installation does not match this deployment.');
      const rejected: IngestResult['rejected'] = [];
      let accepted = 0;
      const now = new Date();
      batch.data.reports.forEach((r, index) => {
        const schema = REPORT_SCHEMAS[r.type] as z.ZodType;
        const parsed = schema.safeParse(r.payload);
        if (!parsed.success) {
          rejected.push({ index, type: r.type, reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).slice(0, 3).join('; ') });
          return;
        }
        const observed = new Date(r.observedAt);
        if (observed.getTime() > now.getTime() + 5 * 60_000 || observed.getTime() < now.getTime() - 30 * 86_400_000) {
          rejected.push({ index, type: r.type, reason: 'observedAt is outside the accepted window' });
          return;
        }
        r.payload = parsed.data as Record<string, unknown>;
        accepted++;
      });
      for (const [index, r] of batch.data.reports.entries()) {
        if (rejected.some((x) => x.index === index)) continue;
        if (r.type === 'database_schema') {
          // Projected per table (Database Explorer); not kept as report history.
          await storeSchemaPart(q, { orgId, clientId: dep.client_id as string, deploymentId }, r.payload as ReportPayload<'database_schema'>, r.observedAt);
          continue;
        }
        await q.query(
          `INSERT INTO deployment_reports (organization_id, client_id, deployment_id, installation_id, report_type, observed_at, agent_version, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orgId, dep.client_id, deploymentId, installationId, r.type, r.observedAt, batch.data.agentVersion, JSON.stringify(r.payload)],
        );
        await q.query(
          `INSERT INTO deployment_report_latest (organization_id, client_id, deployment_id, report_type, observed_at, received_at, payload)
           VALUES ($1, $2, $3, $4, $5, clock_timestamp(), $6)
           ON CONFLICT (deployment_id, report_type) DO UPDATE SET observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at, payload = EXCLUDED.payload
           WHERE deployment_report_latest.observed_at <= EXCLUDED.observed_at`,
          [orgId, dep.client_id, deploymentId, r.type, r.observedAt, JSON.stringify(r.payload)],
        );
        // The appliance ran the real PSA connection test; the instance's status is a projection of its report (Module 11).
        if (r.type === 'psa_integration_status') {
          await applyPsaReport(q, this.audit, { orgId, deploymentId, payload: r.payload as ReportPayload<'psa_integration_status'>, observedAt: r.observedAt });
        }
        if (r.type === 'synchronization') {
          await applySyncReport(q, { deploymentId, payload: r.payload as ReportPayload<'synchronization'> });
        }
      }
      if (rejected.length) {
        await this.audit.write(q, {
          orgId, action: 'agent.report.rejected', outcome: 'failure', actorType: 'agent', actorDisplay: `Agent ${installationId}`, meta: { ip },
          targetType: 'deployment', targetId: deploymentId, targetDisplay: dep.code as string, clientId: dep.client_id as string,
          metadata: { rejected: rejected.map((x) => ({ type: x.type, reason: x.reason })) },
        });
      }
      const evaluation = await this.evaluateIn(q, orgId, deploymentId, 'agent');
      return { accepted, rejected, evaluation };
    });
  }

  /** Re-evaluates after a heartbeat (a deployment may come back from offline). */
  async afterHeartbeat(orgId: string, deploymentId: string): Promise<void> {
    await this.db.tenant({ orgId, scopeAll: true }, (q) => this.evaluateIn(q, orgId, deploymentId, 'agent'));
  }

  // ---- evaluation ----

  private async latestIn(q: Queryable, deploymentId: string): Promise<Partial<{ [T in ReportType]: LatestReport<T> }>> {
    const rows = await q.query<Row>('SELECT report_type, observed_at, received_at, payload FROM deployment_report_latest WHERE deployment_id = $1', [deploymentId]);
    const out: Record<string, LatestReport> = {};
    for (const r of rows) out[r.report_type as string] = { type: r.report_type as ReportType, observedAt: iso(r.observed_at)!, receivedAt: iso(r.received_at)!, payload: r.payload as never };
    return out as Partial<{ [T in ReportType]: LatestReport<T> }>;
  }

  /** Evaluates one deployment, persists the state and findings, and records a health event on change. Returns the evaluation. */
  async evaluateIn(q: Queryable, orgId: string, deploymentId: string, source: 'agent' | 'system'): Promise<HealthEvaluation> {
    const d = await q.one<Row>(
      `SELECT d.id, d.code, d.client_id, d.lifecycle_state, d.health_state, d.health_reason, d.last_heartbeat_at, d.is_synthetic, d.verified_at,
              l.code AS license_code, l.status AS license_status, (l.ends_at - current_date) AS license_days, (l.ends_at IS NOT NULL AND l.ends_at < current_date) AS license_past
       FROM deployments d LEFT JOIN licenses l ON l.id = d.license_id WHERE d.id = $1`,
      [deploymentId],
    );
    if (d.is_synthetic) {
      return { state: d.health_state as HealthState, reason: (d.health_reason as string | null) ?? null, findings: [], evaluatedAt: new Date().toISOString() };
    }
    const policy = await this.policyIn(q, orgId);
    const license = d.license_code
      ? { code: d.license_code as string, status: d.license_status === 'active' && d.license_past ? 'expired' : (d.license_status as string), daysRemaining: (d.license_days as number | null) ?? null }
      : null;
    const ev = evaluateHealth({ now: new Date(), policy, lifecycleState: d.lifecycle_state as string, lastHeartbeatAt: (d.last_heartbeat_at as Date | null) ?? null, latest: await this.latestIn(q, deploymentId), license });
    const becameVerified = ev.state === 'healthy' && d.lifecycle_state === 'enrolled';
    await q.query(
      `UPDATE deployments SET health_state = $2, health_reason = $3, health_findings = $4, health_evaluated_at = $5,
         lifecycle_state = CASE WHEN $6 THEN 'verified' ELSE lifecycle_state END,
         verified_at = CASE WHEN $6 THEN $5 ELSE verified_at END
       WHERE id = $1`,
      [deploymentId, ev.state, ev.reason, JSON.stringify(ev.findings), ev.evaluatedAt, becameVerified],
    );
    if (ev.state !== d.health_state) {
      await q.query(
        `INSERT INTO deployment_health_events (organization_id, client_id, deployment_id, health_state, reason, source, observed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orgId, d.client_id, deploymentId, ev.state, ev.reason?.slice(0, 500) ?? null, source, ev.evaluatedAt],
      );
    }
    if (becameVerified) {
      await this.audit.write(q, {
        orgId, action: 'deployment.verified', outcome: 'success', actorType: 'system', actorDisplay: 'Health evaluation', targetType: 'deployment', targetId: deploymentId,
        targetDisplay: d.code as string, clientId: d.client_id as string, metadata: { code: d.code, basis: 'first healthy evaluation from agent reports' },
      });
    }
    return ev;
  }

  private async evaluateAllIn(q: Queryable, orgId: string, source: 'agent' | 'system') {
    const ids = await q.query<{ id: string }>(`SELECT id FROM deployments WHERE lifecycle_state IN ('enrolled', 'verified') AND NOT is_synthetic`);
    for (const { id } of ids) await this.evaluateIn(q, orgId, id, source);
  }

  /**
   * Cross-organization sweep: offline detection, stale reports, and retention.
   * Each deployment is evaluated in its own short transaction: a single fleet-wide transaction held row locks on
   * `deployments` for the whole sweep, and every heartbeat or report arriving meanwhile waited behind it
   * (seen as multi-second gateway latency at 1,000 agents in the fleet load test).
   */
  async sweep(): Promise<number> {
    const orgs = await this.db.unscoped((q) => q.query<{ app_organizations_with_agents: string }>('SELECT app_organizations_with_agents()'));
    let n = 0;
    for (const { app_organizations_with_agents: orgId } of orgs) {
      const ctx: TenantContext = { orgId, scopeAll: true };
      const ids = await this.db.tenant(ctx, (q) => q.query<{ id: string }>(`SELECT id FROM deployments WHERE lifecycle_state IN ('enrolled', 'verified') AND NOT is_synthetic`));
      for (const { id } of ids) {
        await this.db.tenant(ctx, (q) => this.evaluateIn(q, orgId, id, 'system')).catch((err) => {
          this.logger.warn({ msg: 'Health evaluation failed', deploymentId: id, err }, 'HealthService');
        });
      }
      await this.db.tenant(ctx, async (q) => {
        await q.query(`DELETE FROM deployment_reports WHERE received_at < now() - interval '30 days'`);
        await q.query(`DELETE FROM deployment_heartbeats WHERE received_at < now() - interval '7 days'`);
      });
      n++;
    }
    return n;
  }

  // ---- views ----

  async fleet(auth: AuthContext, query: { state?: HealthState; q?: string; live?: '1' }): Promise<FleetHealthDto> {
    return this.db.tenant(auth, async (q) => {
      const where: string[] = [`d.lifecycle_state <> 'decommissioned'`];
      const params: unknown[] = [];
      if (query.state) { params.push(query.state); where.push(`d.health_state = $${params.length}`); }
      if (query.q) { params.push(`%${escapeLike(query.q)}%`); where.push(`(d.code ILIKE $${params.length} OR c.display_name ILIKE $${params.length} OR c.code ILIKE $${params.length})`); }
      if (query.live) where.push('NOT d.is_synthetic');
      const rows = await q.query<Row>(
        `SELECT d.id, d.code, d.client_id, c.code AS client_code, c.display_name AS client_name, d.is_synthetic, d.lifecycle_state, d.health_state, d.health_reason,
                d.last_heartbeat_at, d.agent_version,
                hr.payload AS resources, db.payload AS database, greatest(hr.received_at, db.received_at) AS last_report_at
         FROM deployments d JOIN clients c ON c.id = d.client_id
         LEFT JOIN deployment_report_latest hr ON hr.deployment_id = d.id AND hr.report_type = 'host_resources'
         LEFT JOIN deployment_report_latest db ON db.deployment_id = d.id AND db.report_type = 'database'
         WHERE ${where.join(' AND ')}
         ORDER BY array_position(ARRAY['critical','offline','degraded','unknown','healthy']::text[], d.health_state), d.is_synthetic, d.code`,
        params,
      );
      const summary = Object.fromEntries(HEALTH_STATES.map((s) => [s, 0])) as Record<HealthState, number>;
      const syntheticSummary = Object.fromEntries(HEALTH_STATES.map((s) => [s, 0])) as Record<HealthState, number>;
      const out: FleetHealthRow[] = rows.map((r) => {
        summary[r.health_state as HealthState]++;
        if (r.is_synthetic) syntheticSummary[r.health_state as HealthState]++;
        const res = r.resources as Row | null;
        const dbp = r.database as Row | null;
        return {
          id: r.id as string, code: r.code as string, client: { id: r.client_id as string, code: r.client_code as string, displayName: r.client_name as string },
          isSynthetic: r.is_synthetic as boolean, lifecycleState: r.lifecycle_state as string, healthState: r.health_state as HealthState,
          healthReason: (r.health_reason as string | null) ?? null, lastHeartbeatAt: iso(r.last_heartbeat_at), agentVersion: (r.agent_version as string | null) ?? null,
          cpuPercent: (res?.cpuPercent as number | null) ?? null,
          memoryPercent: res ? usage(res.memoryUsedBytes as number | null, res.memoryLimitBytes as number | null) : null,
          diskPercent: res ? usage(res.diskUsedBytes as number | null, res.diskTotalBytes as number | null) : null,
          databaseAvailable: dbp ? (dbp.available as boolean) : null,
          lastReportAt: iso(r.last_report_at),
        };
      });
      return { generatedAt: new Date().toISOString(), policy: await this.policyIn(q, auth.orgId), summary, syntheticSummary, rows: out };
    });
  }

  async deployment(auth: AuthContext, id: string): Promise<DeploymentHealthDto> {
    return this.db.tenant(auth, async (q) => {
      const d = await q.maybeOne<Row>(
        `SELECT d.*, c.code AS client_code, c.display_name AS client_name FROM deployments d JOIN clients c ON c.id = d.client_id WHERE d.id = $1`,
        [id],
      );
      if (!d) throw new AppError(404, 'not-found', 'Deployment not found.');
      const latest = await this.latestIn(q, id);
      const history = await q.query<Row>(
        `SELECT observed_at, payload FROM deployment_reports WHERE deployment_id = $1 AND report_type = 'host_resources' AND observed_at > now() - interval '24 hours' ORDER BY observed_at`,
        [id],
      );
      const heartbeats = await q.query<Row>('SELECT received_at, agent_version FROM deployment_heartbeats WHERE deployment_id = $1 ORDER BY received_at DESC LIMIT 50', [id]);
      const events = await q.query<Row>(
        `SELECT health_state, reason, source, observed_at FROM deployment_health_events WHERE deployment_id = $1 AND observed_at > now() - interval '30 days' ORDER BY observed_at DESC LIMIT 100`,
        [id],
      );
      return {
        deploymentId: id, code: d.code as string, client: { id: d.client_id as string, code: d.client_code as string, displayName: d.client_name as string },
        isSynthetic: d.is_synthetic as boolean, lifecycleState: d.lifecycle_state as string, healthState: d.health_state as HealthState,
        healthReason: (d.health_reason as string | null) ?? null, findings: (d.health_findings as HealthFinding[]) ?? [], evaluatedAt: iso(d.health_evaluated_at),
        lastHeartbeatAt: iso(d.last_heartbeat_at), enrolledAt: iso(d.enrolled_at), verifiedAt: iso(d.verified_at), agentVersion: (d.agent_version as string | null) ?? null,
        policy: await this.policyIn(q, auth.orgId), latest,
        resourceHistory: history.map((h) => {
          const p = h.payload as Row;
          return { observedAt: iso(h.observed_at)!, cpuPercent: (p.cpuPercent as number | null) ?? null, memoryPercent: usage(p.memoryUsedBytes as number | null, p.memoryLimitBytes as number | null), diskPercent: usage(p.diskUsedBytes as number | null, p.diskTotalBytes as number | null) };
        }),
        heartbeats: heartbeats.map((h) => ({ receivedAt: iso(h.received_at)!, agentVersion: (h.agent_version as string | null) ?? null })),
        events: events.map((e) => ({ healthState: e.health_state as HealthState, reason: (e.reason as string | null) ?? null, source: e.source as 'agent' | 'system' | 'synthetic', observedAt: iso(e.observed_at)! })),
      };
    });
  }
}
