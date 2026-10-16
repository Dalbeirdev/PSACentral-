import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DEFAULT_RETENTION_POLICY, type RetentionPolicy, type RetentionPolicyDto, type RetentionPurgeResult } from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { JsonLogger } from '../../common/logger.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
/** The retention sweep runs hourly; a purge is due only once a deployment has been decommissioned for the whole retention period. */
const SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Module 15 — retention of decommissioned deployments' operational metadata. The policy is per
 * organization (default 90 days). The sweep deletes reports, heartbeats, inventory, health events and
 * commands of deployments decommissioned longer than that, audits each purge, and leaves the deployment
 * record, its identity history and the audit trail in place.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      this.sweep()
        .then((n) => n && this.logger.log({ msg: 'Decommissioned deployment metadata purged', count: n }, 'RetentionService'))
        .catch((err) => this.logger.warn({ msg: 'Retention sweep failed', err }, 'RetentionService'));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Cross-organization sweep (the tests call it directly). */
  async sweep(): Promise<number> {
    const r = await this.db.unscoped((q) => q.one<{ n: number }>('SELECT app_purge_decommissioned() AS n'));
    return r.n;
  }

  static async daysIn(q: Queryable, orgId: string): Promise<number> {
    const r = await q.maybeOne<{ d: number }>('SELECT decommissioned_metadata_days AS d FROM retention_policies WHERE organization_id = $1', [orgId]);
    return r?.d ?? DEFAULT_RETENTION_POLICY.decommissionedMetadataDays;
  }

  private async dtoIn(q: Queryable, orgId: string): Promise<RetentionPolicyDto> {
    const row = await q.maybeOne<Row>(
      `SELECT p.decommissioned_metadata_days, p.updated_at, u.display_name AS updated_by
       FROM retention_policies p LEFT JOIN users u ON u.id = p.updated_by WHERE p.organization_id = $1`,
      [orgId],
    );
    const days = (row?.decommissioned_metadata_days as number | undefined) ?? DEFAULT_RETENTION_POLICY.decommissionedMetadataDays;
    const stats = await q.one<{ decommissioned: number; awaiting: number; purged: number; next_at: Date | null }>(
      `SELECT count(*)::int AS decommissioned,
              count(*) FILTER (WHERE metadata_purged_at IS NULL)::int AS awaiting,
              count(*) FILTER (WHERE metadata_purged_at IS NOT NULL)::int AS purged,
              min(decommissioned_at) FILTER (WHERE metadata_purged_at IS NULL) + make_interval(days => $1) AS next_at
       FROM deployments WHERE lifecycle_state = 'decommissioned'`,
      [days],
    );
    return {
      decommissionedMetadataDays: days,
      updatedAt: iso(row?.updated_at),
      updatedBy: (row?.updated_by as string | null) ?? null,
      stats: { decommissioned: stats.decommissioned, awaitingPurge: stats.awaiting, purged: stats.purged, nextPurgeAt: iso(stats.next_at) },
    };
  }

  async policy(auth: AuthContext): Promise<RetentionPolicyDto> {
    return this.db.tenant(auth, (q) => this.dtoIn(q, auth.orgId));
  }

  async updatePolicy(auth: AuthContext, p: RetentionPolicy, meta: RequestMeta): Promise<RetentionPolicyDto> {
    return this.db.tenant(auth, async (q) => {
      const before = await RetentionService.daysIn(q, auth.orgId);
      await q.query(
        `INSERT INTO retention_policies (organization_id, decommissioned_metadata_days, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (organization_id) DO UPDATE SET decommissioned_metadata_days = EXCLUDED.decommissioned_metadata_days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [auth.orgId, p.decommissionedMetadataDays, auth.userId],
      );
      if (before !== p.decommissionedMetadataDays) {
        const actor = (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
        await this.audit.write(q, {
          orgId: auth.orgId, action: 'retention_policy.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: actor, meta,
          targetType: 'retention_policy', targetId: auth.orgId, metadata: { decommissionedMetadataDays: { from: before, to: p.decommissionedMetadataDays } },
        });
      }
      return this.dtoIn(q, auth.orgId);
    });
  }

  /** Runs the purge for this organization now (what is due under the current policy); audited per deployment by the function itself. */
  async purgeNow(auth: AuthContext, meta: RequestMeta): Promise<RetentionPurgeResult> {
    return this.db.tenant(auth, async (q) => {
      const n = (await q.one<{ n: number }>('SELECT app_purge_decommissioned($1) AS n', [auth.orgId])).n;
      const actor = (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'retention_policy.purge_run', outcome: 'success', actorUserId: auth.userId, actorDisplay: actor, meta,
        targetType: 'retention_policy', targetId: auth.orgId, metadata: { purgedDeployments: n },
      });
      return { purgedDeployments: n, ranAt: new Date().toISOString() };
    });
  }
}
