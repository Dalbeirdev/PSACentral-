import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  LICENSE_EXPIRING_DAYS,
  type LicenseAction,
  type LicenseCreate,
  type LicenseDeploymentRow,
  type LicenseDetail,
  type LicenseListQuery,
  type LicenseStats,
  type LicenseStatus,
  type LicenseSummary,
  type LicenseUpdate,
  type Paged,
} from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { JsonLogger } from '../../common/logger.js';
import { AppError } from '../../common/problem.filter.js';
import { ValidationFailedException } from '../../common/zod.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService, escapeLike } from '../audit/audit.service.js';

/**
 * Licenses (Module 14): per-client entitlements with their own identifier (LIC-xxxxx), a plan name, a
 * term and a maximum number of deployments. Deployments bind to one; packages and enrollment need an
 * active license; expiry is swept daily and flagged by the health rules.
 */

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : null);
const SWEEP_INTERVAL_MS = 60 * 60_000;

const SELECT = `
  SELECT l.*, c.code AS client_code, c.display_name AS client_name,
         (SELECT count(*)::int FROM deployments d WHERE d.license_id = l.id AND d.lifecycle_state <> 'decommissioned') AS deployments_used,
         (l.ends_at - current_date) AS days_remaining
  FROM licenses l JOIN clients c ON c.id = l.client_id`;

const SORT: Record<string, string> = {
  code: 'l.code', client: 'c.display_name', endsAt: 'l.ends_at', status: 'l.status',
};

/** Days until an end date on the calendar (negative when passed); null for perpetual licenses. */
export function daysRemaining(endsAt: string | null, now = new Date()): number | null {
  if (!endsAt) return null;
  const end = Date.UTC(Number(endsAt.slice(0, 4)), Number(endsAt.slice(5, 7)) - 1, Number(endsAt.slice(8, 10)));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - today) / 86_400_000);
}

export function toSummary(r: Row): LicenseSummary {
  const endsAt = ymd(r.ends_at);
  const days = daysRemaining(endsAt);
  return {
    id: r.id as string,
    code: r.code as string,
    client: { id: r.client_id as string, code: r.client_code as string, displayName: r.client_name as string },
    displayName: r.display_name as string,
    status: r.status as LicenseStatus,
    startsAt: ymd(r.starts_at)!,
    endsAt,
    daysRemaining: days,
    expiring: r.status === 'active' && days !== null && days <= LICENSE_EXPIRING_DAYS,
    maxDeployments: r.max_deployments as number,
    deploymentsUsed: (r.deployments_used as number) ?? 0,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    isSynthetic: r.is_synthetic as boolean,
  };
}

@Injectable()
export class LicensesService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      this.sweepExpired()
        .then((n) => n && this.logger.log({ msg: 'Licenses expired', count: n }, 'LicensesService'))
        .catch((err) => this.logger.warn({ msg: 'License expiry sweep failed', err }, 'LicensesService'));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Cross-organization sweep (hourly in the API process; the tests call it directly). */
  async sweepExpired(): Promise<number> {
    const r = await this.db.unscoped((q) => q.one<{ n: number }>('SELECT app_expire_licenses() AS n'));
    return r.n;
  }

  private async actor(q: Queryable, auth: AuthContext) {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  private async require(q: Queryable, id: string, lock = false): Promise<Row> {
    const r = await q.maybeOne<Row>(`${SELECT} WHERE l.id = $1 ${lock ? 'FOR UPDATE OF l' : ''}`, [id]);
    if (!r) throw new AppError(404, 'not-found', 'License not found.');
    return r;
  }

  private async detailIn(q: Queryable, id: string): Promise<LicenseDetail> {
    const r = await this.require(q, id);
    const deps = await q.query<Row>(
      `SELECT id, code, lifecycle_state, health_state, host_label, suspended_at FROM deployments WHERE license_id = $1 ORDER BY code`,
      [id],
    );
    const names = await q.query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])', [[r.created_by, r.updated_by].filter(Boolean)]);
    const name = (u: unknown) => names.find((n) => n.id === u)?.display_name ?? null;
    return {
      ...toSummary(r),
      notes: (r.notes as string | null) ?? null,
      suspendedAt: iso(r.suspended_at),
      suspendedReason: (r.suspended_reason as string | null) ?? null,
      revokedAt: iso(r.revoked_at),
      revokeReason: (r.revoke_reason as string | null) ?? null,
      createdBy: name(r.created_by),
      updatedBy: name(r.updated_by),
      version: r.version as number,
      deployments: deps.map((d): LicenseDeploymentRow => ({
        id: d.id as string, code: d.code as string, lifecycleState: d.lifecycle_state as LicenseDeploymentRow['lifecycleState'],
        healthState: d.health_state as LicenseDeploymentRow['healthState'], hostLabel: (d.host_label as string | null) ?? null, suspendedAt: iso(d.suspended_at),
      })),
    };
  }

  async list(auth: AuthContext, query: LicenseListQuery): Promise<Paged<LicenseSummary>> {
    return this.db.tenant(auth, async (q) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.q) {
        params.push(`%${escapeLike(query.q)}%`);
        where.push(`(l.code ILIKE $${params.length} OR l.display_name ILIKE $${params.length} OR c.display_name ILIKE $${params.length} OR c.code ILIKE $${params.length})`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`l.status = $${params.length}`);
      }
      if (query.clientId) {
        params.push(query.clientId);
        where.push(`l.client_id = $${params.length}`);
      }
      if (query.expiringWithinDays) {
        params.push(query.expiringWithinDays);
        where.push(`l.status = 'active' AND l.ends_at IS NOT NULL AND l.ends_at <= current_date + ($${params.length}::int)`);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const desc = query.sort.startsWith('-');
      const field = query.sort.replace(/^-/, '');
      const order = `${SORT[field]} ${desc ? 'DESC' : 'ASC'}${field === 'endsAt' ? ' NULLS LAST' : ''}, l.code ASC`;
      const total = (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM licenses l JOIN clients c ON c.id = l.client_id ${w}`, params)).n;
      const rows = await q.query<Row>(`${SELECT} ${w} ORDER BY ${order} LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`, params);
      return { items: rows.map(toSummary), total, page: query.page, pageSize: query.pageSize };
    });
  }

  async stats(auth: AuthContext): Promise<LicenseStats> {
    return this.db.tenant(auth, async (q) => {
      const rows = await q.query<{ status: LicenseStatus; n: number }>('SELECT status, count(*)::int AS n FROM licenses GROUP BY status');
      const expiring = (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM licenses WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= current_date + $1::int`, [LICENSE_EXPIRING_DAYS])).n;
      const out: LicenseStats = { active: 0, suspended: 0, expired: 0, revoked: 0, total: 0, expiring };
      for (const r of rows) {
        out[r.status] = r.n;
        out.total += r.n;
      }
      return out;
    });
  }

  async detail(auth: AuthContext, id: string): Promise<LicenseDetail> {
    return this.db.tenant(auth, (q) => this.detailIn(q, id));
  }

  async create(auth: AuthContext, dto: LicenseCreate, meta: RequestMeta): Promise<LicenseDetail> {
    return this.db.tenant(auth, async (q) => {
      const client = await q.maybeOne<{ status: string; is_synthetic: boolean }>('SELECT status, is_synthetic FROM clients WHERE id = $1', [dto.clientId]);
      if (!client) throw new ValidationFailedException([{ path: 'clientId', message: 'Choose a client you have access to.' }]);
      if (client.status === 'offboarded') throw new ValidationFailedException([{ path: 'clientId', message: 'An offboarded client cannot get a new license.' }]);
      const id = randomUUID();
      await q.query(
        `INSERT INTO licenses (id, organization_id, client_id, code, display_name, starts_at, ends_at, max_deployments, notes, created_by, updated_by)
         VALUES ($1, $2, $3, next_org_code('license', 'LIC'), $4, $5::date, $6::date, $7, $8, $9, $9)`,
        [id, auth.orgId, dto.clientId, dto.displayName, dto.startsAt, dto.endsAt, dto.maxDeployments, dto.notes || null, auth.userId],
      );
      const d = await this.detailIn(q, id);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'license.created', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'license', targetId: id, targetDisplay: d.code, clientId: dto.clientId,
        metadata: { code: d.code, displayName: dto.displayName, startsAt: dto.startsAt, endsAt: dto.endsAt, maxDeployments: dto.maxDeployments },
      });
      return d;
    });
  }

  async update(auth: AuthContext, id: string, dto: LicenseUpdate, meta: RequestMeta): Promise<LicenseDetail> {
    return this.db.tenant(auth, async (q) => {
      const r = await this.require(q, id, true);
      if (r.version !== dto.version) throw new AppError(409, 'version-conflict', 'The license was changed by someone else. Reload and try again.');
      if (r.status === 'revoked') throw new AppError(409, 'license-revoked', 'A revoked license cannot be edited.');
      const used = r.deployments_used as number;
      if (dto.maxDeployments < used) throw new ValidationFailedException([{ path: 'maxDeployments', message: `${used} deployment(s) already run under this license.` }]);
      await q.query(
        `UPDATE licenses SET display_name = $2, starts_at = $3::date, ends_at = $4::date, max_deployments = $5, notes = $6, updated_by = $7, updated_at = now(), version = version + 1
         WHERE id = $1`,
        [id, dto.displayName, dto.startsAt, dto.endsAt, dto.maxDeployments, dto.notes || null, auth.userId],
      );
      // An extended term brings an expired license back to active; the daily sweep expires it again if the date passes.
      if (r.status === 'expired' && (dto.endsAt === null || dto.endsAt >= new Date().toISOString().slice(0, 10))) {
        await q.query(`UPDATE licenses SET status = 'active' WHERE id = $1`, [id]);
      }
      const d = await this.detailIn(q, id);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'license.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'license', targetId: id, targetDisplay: d.code, clientId: r.client_id as string,
        metadata: { from: { displayName: r.display_name, startsAt: ymd(r.starts_at), endsAt: ymd(r.ends_at), maxDeployments: r.max_deployments, status: r.status }, to: { displayName: dto.displayName, startsAt: dto.startsAt, endsAt: dto.endsAt, maxDeployments: dto.maxDeployments, status: d.status } },
      });
      return d;
    });
  }

  private async transition(auth: AuthContext, id: string, to: 'suspended' | 'active' | 'revoked', dto: LicenseAction, meta: RequestMeta): Promise<LicenseDetail> {
    return this.db.tenant(auth, async (q) => {
      const r = await this.require(q, id, true);
      const from = r.status as LicenseStatus;
      const allowed: Record<typeof to, LicenseStatus[]> = { suspended: ['active'], active: ['suspended'], revoked: ['active', 'suspended', 'expired'] };
      if (!allowed[to].includes(from)) throw new AppError(409, 'invalid-transition', `A ${from} license cannot become ${to}.`);
      if (to === 'suspended') await q.query(`UPDATE licenses SET status = 'suspended', suspended_at = clock_timestamp(), suspended_reason = $2, updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1`, [id, dto.reason, auth.userId]);
      if (to === 'active') await q.query(`UPDATE licenses SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_by = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [id, auth.userId]);
      if (to === 'revoked') await q.query(`UPDATE licenses SET status = 'revoked', revoked_at = clock_timestamp(), revoke_reason = $2, suspended_at = NULL, suspended_reason = NULL, updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1`, [id, dto.reason, auth.userId]);
      const action = { suspended: 'license.suspended', active: 'license.resumed', revoked: 'license.revoked' }[to];
      await this.audit.write(q, {
        orgId: auth.orgId, action, outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'license', targetId: id, targetDisplay: r.code as string, clientId: r.client_id as string,
        metadata: { from, to, reason: dto.reason, deployments: r.deployments_used },
      });
      return this.detailIn(q, id);
    });
  }

  suspend(auth: AuthContext, id: string, dto: LicenseAction, meta: RequestMeta) { return this.transition(auth, id, 'suspended', dto, meta); }
  resume(auth: AuthContext, id: string, dto: LicenseAction, meta: RequestMeta) { return this.transition(auth, id, 'active', dto, meta); }
  revoke(auth: AuthContext, id: string, dto: LicenseAction, meta: RequestMeta) { return this.transition(auth, id, 'revoked', dto, meta); }

  /** The client's active license with free capacity, if any (used when a deployment is created without one). */
  static async defaultLicenseFor(q: Queryable, clientId: string): Promise<string | null> {
    const r = await q.maybeOne<{ id: string }>(
      `SELECT l.id FROM licenses l
       WHERE l.client_id = $1 AND l.status = 'active' AND (l.ends_at IS NULL OR l.ends_at >= current_date)
         AND (SELECT count(*) FROM deployments d WHERE d.license_id = l.id AND d.lifecycle_state <> 'decommissioned') < l.max_deployments
       ORDER BY l.ends_at DESC NULLS FIRST, l.created_at LIMIT 1`,
      [clientId],
    );
    return r?.id ?? null;
  }
}
