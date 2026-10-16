import { Inject, Injectable } from '@nestjs/common';
import type { AuditEventDto, AuditOutcome, AuditQuery, Paged } from '@psacc/contracts';
import type { AuthContext, RequestMeta, TenantContext } from '../../common/auth-context.js';
import { maskSecrets } from '../../common/logger.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';

export interface AuditEntry {
  orgId: string;
  action: string;
  outcome: AuditOutcome;
  actorType?: 'user' | 'system' | 'agent';
  actorUserId?: string | null;
  actorDisplay: string;
  targetType?: string;
  targetId?: string;
  targetDisplay?: string;
  clientId?: string;
  meta?: Partial<RequestMeta>;
  metadata?: Record<string, unknown>;
}

const SORTABLE: Record<string, string> = {
  occurredAt: 'occurred_at',
  action: 'action',
  outcome: 'outcome',
  actor: 'actor_display',
};

/** Append-only audit trail. The database grants the API INSERT + SELECT only on audit_events. */
@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /** Write inside an existing tenant transaction (atomic with the audited change). */
  async write(q: Queryable, e: AuditEntry): Promise<void> {
    await q.query(
      // clock_timestamp(): events written in one transaction keep their real order (now() is per-transaction).
      `INSERT INTO audit_events (organization_id, occurred_at, actor_type, actor_user_id, actor_display, action, target_type,
         target_id, target_display, client_id, outcome, ip, user_agent, request_id, metadata)
       VALUES ($1, clock_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        e.orgId,
        e.actorType ?? 'user',
        e.actorUserId ?? null,
        e.actorDisplay.slice(0, 200),
        e.action,
        e.targetType ?? null,
        e.targetId ?? null,
        e.targetDisplay?.slice(0, 200) ?? null,
        e.clientId ?? null,
        e.outcome,
        e.meta?.ip ?? null,
        e.meta?.userAgent ?? null,
        e.meta?.requestId ?? null,
        JSON.stringify(maskSecrets(e.metadata ?? {})),
      ],
    );
  }

  /** Write in its own transaction (e.g. failures/denials where the main transaction rolled back). */
  async record(ctx: TenantContext | AuthContext, e: Omit<AuditEntry, 'orgId'>): Promise<void> {
    await this.db.tenant(ctx, (q) => this.write(q, { ...e, orgId: ctx.orgId }));
  }

  async list(ctx: AuthContext, query: AuditQuery): Promise<Paged<AuditEventDto>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (query.outcome) add('outcome = ?', query.outcome);
    if (query.action) add('action LIKE ?', query.action.replace(/\*/g, '%') + (query.action.includes('*') ? '' : '%'));
    if (query.from) add('occurred_at >= ?', query.from);
    if (query.to) add('occurred_at <= ?', query.to);
    if (query.targetType) add('target_type = ?', query.targetType);
    if (query.targetId) add('target_id = ?', query.targetId);
    if (query.q) add(`(actor_display ILIKE ? OR coalesce(target_display, '') ILIKE $${params.length + 1} OR action ILIKE $${params.length + 1})`, `%${escapeLike(query.q)}%`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [field, dir] = (query.sort ?? 'occurredAt:desc').split(':') as [string, string];
    const orderCol = SORTABLE[field] ?? 'occurred_at';
    const orderDir = dir === 'asc' ? 'ASC' : 'DESC';

    return this.db.tenant(ctx, async (q) => {
      const total = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events ${whereSql}`, params);
      const rows = await q.query<Record<string, unknown>>(
        `SELECT id, occurred_at, actor_type, actor_user_id, actor_display, action, target_type, target_id,
                target_display, outcome, host(ip) AS ip, request_id, metadata
         FROM audit_events ${whereSql}
         ORDER BY ${orderCol} ${orderDir}, id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return {
        items: rows.map((r) => ({
          id: r.id as string,
          occurredAt: (r.occurred_at as Date).toISOString(),
          actorType: r.actor_type as AuditEventDto['actorType'],
          actorUserId: (r.actor_user_id as string | null) ?? null,
          actorDisplay: r.actor_display as string,
          action: r.action as string,
          targetType: (r.target_type as string | null) ?? null,
          targetId: (r.target_id as string | null) ?? null,
          targetDisplay: (r.target_display as string | null) ?? null,
          outcome: r.outcome as AuditOutcome,
          ip: (r.ip as string | null) ?? null,
          requestId: (r.request_id as string | null) ?? null,
          metadata: (r.metadata as Record<string, unknown>) ?? {},
        })),
        page: query.page,
        pageSize: query.pageSize,
        total: total.n,
      };
    });
  }
}

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
