import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditEventDto,
  type AuditOutcome,
  checkServiceConfig,
  type ConfigRequirement,
  type IntegrationDependencyKey,
  type Paged,
  type ServiceCategoryCreate,
  type ServiceCategoryDto,
  type ServiceCategoryUpdate,
  type ServiceCreate,
  type ServiceDetail,
  type ServiceDto,
  type ServiceListQuery,
  type ServiceSummary,
  type ServiceUpdate,
} from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { AppError } from '../../common/problem.filter.js';
import { ValidationFailedException } from '../../common/zod.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService, escapeLike } from '../audit/audit.service.js';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
/** Optimistic concurrency token: microseconds of updated_at (changes on every write through the trigger). */
const VERSION = (alias: string) => `(extract(epoch FROM ${alias}.updated_at) * 1000000)::bigint::text`;

const SERVICE_SELECT = `
  SELECT s.*, ${VERSION('s')} AS version, sc.id AS cat_id, sc.key AS cat_key, sc.name AS cat_name,
         (SELECT count(*)::int FROM client_services cs WHERE cs.service_id = s.id) AS client_count,
         cu.display_name AS created_by_name, uu.display_name AS updated_by_name
  FROM services s
  JOIN service_categories sc ON sc.id = s.category_id
  LEFT JOIN users cu ON cu.id = s.created_by
  LEFT JOIN users uu ON uu.id = s.updated_by`;

/** Catalog row → DTO. Shared with client assignment and onboarding. */
export function serviceDto(r: Row): ServiceDto {
  return {
    id: r.id as string,
    key: r.key as string,
    name: r.name as string,
    description: r.description as string,
    category: { id: (r.cat_id as string | undefined) ?? (r.category_id as string), key: r.cat_key as string, name: r.cat_name as string },
    isActive: r.is_active as boolean,
    isDefault: r.is_default as boolean,
    requiresPsa: r.requires_psa as boolean,
    integrationDependencies: r.integration_dependencies as IntegrationDependencyKey[],
    configRequirements: (r.config_requirements as ConfigRequirement[]) ?? [],
    sortOrder: r.sort_order as number,
  };
}

function summaryDto(r: Row): ServiceSummary {
  return { ...serviceDto(r), clientCount: r.client_count as number, updatedAt: iso(r.updated_at)! };
}

@Injectable()
export class ServicesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async actor(q: Queryable, auth: AuthContext) {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  private async require(q: Queryable, id: string): Promise<Row> {
    const r = await q.maybeOne<Row>(`${SERVICE_SELECT} WHERE s.id = $1`, [id]);
    if (!r) throw new AppError(404, 'not-found', 'Service not found.');
    return r;
  }

  private async requireCategory(q: Queryable, id: string, path = 'categoryId'): Promise<Row> {
    const c = await q.maybeOne<Row>(`SELECT *, ${VERSION('service_categories')} AS version FROM service_categories WHERE id = $1`, [id]);
    if (!c) throw new ValidationFailedException([{ path, message: 'Choose a category.' }]);
    return c;
  }

  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------

  /** The catalog with usage counts; filters run in SQL. Small by nature, so it is not paged. */
  async list(auth: AuthContext, query: ServiceListQuery): Promise<ServiceSummary[]> {
    return this.db.tenant(auth, async (q) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.q) {
        params.push(`%${escapeLike(query.q)}%`);
        where.push(`(s.name ILIKE $${params.length} OR s.key ILIKE $${params.length} OR s.description ILIKE $${params.length})`);
      }
      if (query.category) { params.push(query.category); where.push(`sc.key = $${params.length}`); }
      if (query.status) where.push(query.status === 'active' ? 's.is_active' : 'NOT s.is_active');
      if (query.dependency) { params.push(query.dependency); where.push(`$${params.length} = ANY(s.integration_dependencies)`); }
      if (query.usesPsa) where.push(query.usesPsa === '1' ? 's.requires_psa' : 'NOT s.requires_psa');
      const rows = await q.query<Row>(`${SERVICE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sc.sort_order, s.sort_order, s.name`, params);
      return rows.map(summaryDto);
    });
  }

  async detail(auth: AuthContext, id: string): Promise<ServiceDetail> {
    return this.db.tenant(auth, (q) => this.detailIn(q, id));
  }

  private async detailIn(q: Queryable, id: string): Promise<ServiceDetail> {
    const r = await this.require(q, id);
    const requirements = (r.config_requirements as ConfigRequirement[]) ?? [];
    const clients = await q.query<Row>(
      `SELECT c.id, c.code, c.display_name, c.status, c.is_synthetic, cs.config
       FROM client_services cs JOIN clients c ON c.id = cs.client_id
       WHERE cs.service_id = $1 ORDER BY c.display_name`,
      [id],
    );
    const deployments = await q.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM deployments d
       WHERE d.lifecycle_state <> 'decommissioned' AND EXISTS (SELECT 1 FROM client_services cs WHERE cs.client_id = d.client_id AND cs.service_id = $1)`,
      [id],
    );
    return {
      ...summaryDto(r),
      clients: clients.map((c) => ({
        id: c.id as string, code: c.code as string, displayName: c.display_name as string, status: c.status as string, isSynthetic: c.is_synthetic as boolean,
        configComplete: checkServiceConfig(requirements, c.config as Record<string, unknown>).issues.length === 0,
      })),
      deploymentCount: deployments.n,
      createdAt: iso(r.created_at)!,
      createdBy: (r.created_by_name as string | null) ?? null,
      updatedBy: (r.updated_by_name as string | null) ?? null,
      version: r.version as string,
    };
  }

  async create(auth: AuthContext, dto: ServiceCreate, meta: RequestMeta): Promise<ServiceDetail> {
    return this.db.tenant(auth, async (q) => {
      const category = await this.requireCategory(q, dto.categoryId);
      const id = randomUUID();
      try {
        await q.query(
          `INSERT INTO services (id, organization_id, category_id, key, name, description, is_active, is_default, requires_psa, integration_dependencies,
             config_requirements, sort_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, $11, $12, $12)`,
          [id, auth.orgId, dto.categoryId, dto.key, dto.name, dto.description, dto.isDefault, dto.requiresPsa, dto.integrationDependencies,
            JSON.stringify(dto.configRequirements), dto.sortOrder, auth.userId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ValidationFailedException([{ path: 'key', message: 'A service with this key already exists.' }]);
        throw err;
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'service.created', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'service', targetId: id, targetDisplay: dto.name,
        metadata: { key: dto.key, category: category.key, isDefault: dto.isDefault, requiresPsa: dto.requiresPsa, dependencies: dto.integrationDependencies, requirements: dto.configRequirements.map((r) => r.key) },
      });
      return this.detailIn(q, id);
    });
  }

  async update(auth: AuthContext, id: string, dto: ServiceUpdate, meta: RequestMeta): Promise<ServiceDetail> {
    return this.db.tenant(auth, async (q) => {
      const before = await this.require(q, id);
      if (before.version !== dto.version) {
        throw new AppError(409, 'stale-version', 'This service was changed by someone else after you opened it. Reload to see the latest version.');
      }
      if (dto.isDefault && !before.is_active) throw new ValidationFailedException([{ path: 'isDefault', message: 'Activate the service before making it a default.' }]);
      const category = await this.requireCategory(q, dto.categoryId);
      await q.query(
        `UPDATE services SET category_id = $2, name = $3, description = $4, is_default = $5, requires_psa = $6, integration_dependencies = $7,
           config_requirements = $8, sort_order = $9, updated_by = $10
         WHERE id = $1`,
        [id, dto.categoryId, dto.name, dto.description, dto.isDefault, dto.requiresPsa, dto.integrationDependencies, JSON.stringify(dto.configRequirements), dto.sortOrder, auth.userId],
      );
      const prev = {
        categoryId: before.category_id, name: before.name, description: before.description, isDefault: before.is_default, requiresPsa: before.requires_psa,
        integrationDependencies: before.integration_dependencies, configRequirements: (before.config_requirements as ConfigRequirement[]).map((r) => r.key), sortOrder: before.sort_order,
      };
      const next = {
        categoryId: dto.categoryId, name: dto.name, description: dto.description, isDefault: dto.isDefault, requiresPsa: dto.requiresPsa,
        integrationDependencies: dto.integrationDependencies, configRequirements: dto.configRequirements.map((r) => r.key), sortOrder: dto.sortOrder,
      };
      const changes = Object.fromEntries(
        (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k])).map((k) => [k, { from: prev[k], to: next[k] }]),
      );
      const requirementsChanged = JSON.stringify(before.config_requirements) !== JSON.stringify(dto.configRequirements);
      if (requirementsChanged && !('configRequirements' in changes)) changes.configRequirements = { from: prev.configRequirements, to: next.configRequirements };
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'service.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'service', targetId: id, targetDisplay: dto.name, metadata: { key: before.key, category: category.key, changes, assignedClients: before.client_count },
      });
      return this.detailIn(q, id);
    });
  }

  /** Deactivation keeps existing assignments (appliances keep running); new assignments are refused. Defaults must stay active. */
  async setActive(auth: AuthContext, id: string, active: boolean, version: string, meta: RequestMeta): Promise<ServiceDetail> {
    return this.db.tenant(auth, async (q) => {
      const before = await this.require(q, id);
      if (before.version !== version) throw new AppError(409, 'stale-version', 'This service was changed by someone else after you opened it. Reload to see the latest version.');
      if (before.is_active === active) return this.detailIn(q, id);
      if (!active && before.is_default) throw new AppError(409, 'service-is-default', 'Default services must stay active. Remove the default flag first, then deactivate.');
      await q.query('UPDATE services SET is_active = $2, updated_by = $3 WHERE id = $1', [id, active, auth.userId]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: active ? 'service.activated' : 'service.deactivated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'service', targetId: id, targetDisplay: before.name as string, metadata: { key: before.key, assignedClients: before.client_count },
      });
      return this.detailIn(q, id);
    });
  }

  /** Audit events about the service itself and every client assignment change that involved it. */
  async activity(auth: AuthContext, id: string, page: number, pageSize: number): Promise<Paged<AuditEventDto>> {
    return this.db.tenant(auth, async (q) => {
      const s = await this.require(q, id);
      const filter = `((target_type = 'service' AND target_id = $1) OR (action = 'client.services.updated' AND (metadata->'added' ? $2 OR metadata->'removed' ? $2 OR metadata->'configured' ? $2)))`;
      const params = [id, s.key];
      const total = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE ${filter}`, params);
      const rows = await q.query<Row>(
        `SELECT id, occurred_at, actor_type, actor_user_id, actor_display, action, target_type, target_id, target_display, outcome, host(ip) AS ip, request_id, metadata
         FROM audit_events WHERE ${filter} ORDER BY occurred_at DESC LIMIT $3 OFFSET $4`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      return {
        items: rows.map((r) => ({
          id: r.id as string, occurredAt: iso(r.occurred_at)!, actorType: r.actor_type as AuditEventDto['actorType'],
          actorUserId: (r.actor_user_id as string | null) ?? null, actorDisplay: r.actor_display as string, action: r.action as string,
          targetType: (r.target_type as string | null) ?? null, targetId: (r.target_id as string | null) ?? null,
          targetDisplay: (r.target_display as string | null) ?? null, outcome: r.outcome as AuditOutcome, ip: (r.ip as string | null) ?? null,
          requestId: (r.request_id as string | null) ?? null, metadata: (r.metadata as Record<string, unknown>) ?? {},
        })),
        page, pageSize, total: total.n,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------

  async categories(auth: AuthContext): Promise<ServiceCategoryDto[]> {
    return this.db.tenant(auth, (q) => this.categoriesIn(q));
  }

  private async categoriesIn(q: Queryable): Promise<ServiceCategoryDto[]> {
    const rows = await q.query<Row>(
      `SELECT sc.*, ${VERSION('sc')} AS version,
              (SELECT count(*)::int FROM services s WHERE s.category_id = sc.id) AS service_count,
              (SELECT count(*)::int FROM services s WHERE s.category_id = sc.id AND s.is_active) AS active_count
       FROM service_categories sc ORDER BY sc.sort_order, sc.name`,
    );
    return rows.map((r) => ({
      id: r.id as string, key: r.key as string, name: r.name as string, sortOrder: r.sort_order as number, serviceCount: r.service_count as number,
      activeServiceCount: r.active_count as number, version: r.version as string, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    }));
  }

  async createCategory(auth: AuthContext, dto: ServiceCategoryCreate, meta: RequestMeta): Promise<ServiceCategoryDto> {
    return this.db.tenant(auth, async (q) => {
      const id = randomUUID();
      try {
        await q.query('INSERT INTO service_categories (id, organization_id, key, name, sort_order) VALUES ($1, $2, $3, $4, $5)', [id, auth.orgId, dto.key, dto.name, dto.sortOrder]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ValidationFailedException([{ path: 'key', message: 'A category with this key already exists.' }]);
        throw err;
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'service_category.created', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'service_category', targetId: id, targetDisplay: dto.name, metadata: { key: dto.key, sortOrder: dto.sortOrder },
      });
      return (await this.categoriesIn(q)).find((c) => c.id === id)!;
    });
  }

  async updateCategory(auth: AuthContext, id: string, dto: ServiceCategoryUpdate, meta: RequestMeta): Promise<ServiceCategoryDto> {
    return this.db.tenant(auth, async (q) => {
      const before = await q.maybeOne<Row>(`SELECT *, ${VERSION('service_categories')} AS version FROM service_categories WHERE id = $1`, [id]);
      if (!before) throw new AppError(404, 'not-found', 'Category not found.');
      if (before.version !== dto.version) throw new AppError(409, 'stale-version', 'This category was changed by someone else after you opened it. Reload to see the latest version.');
      await q.query('UPDATE service_categories SET name = $2, sort_order = $3 WHERE id = $1', [id, dto.name, dto.sortOrder]);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (before.name !== dto.name) changes.name = { from: before.name, to: dto.name };
      if (before.sort_order !== dto.sortOrder) changes.sortOrder = { from: before.sort_order, to: dto.sortOrder };
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'service_category.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'service_category', targetId: id, targetDisplay: dto.name, metadata: { key: before.key, changes },
      });
      return (await this.categoriesIn(q)).find((c) => c.id === id)!;
    });
  }

  /** Only empty categories can be deleted; move or deactivate services first (they keep their category either way). */
  async deleteCategory(auth: AuthContext, id: string, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth, async (q) => {
      const before = await q.maybeOne<Row>('SELECT * FROM service_categories WHERE id = $1', [id]);
      if (!before) throw new AppError(404, 'not-found', 'Category not found.');
      const used = await q.one<{ n: number }>('SELECT count(*)::int AS n FROM services WHERE category_id = $1', [id]);
      if (used.n > 0) throw new AppError(409, 'category-in-use', `${used.n} service(s) use this category. Move them to another category first.`);
      await q.query('DELETE FROM service_categories WHERE id = $1', [id]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'service_category.deleted', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'service_category', targetId: id, targetDisplay: before.name as string, metadata: { key: before.key },
      });
    });
  }
}
