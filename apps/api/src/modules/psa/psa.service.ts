import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditEventDto,
  AuditOutcome,
  Paged,
  PsaInstanceCreate,
  PsaInstanceDetail,
  PsaInstanceListQuery,
  PsaInstanceSummary,
  PsaInstanceUpdate,
  PsaProviderDescriptor,
  IntegrationListQuery,
  IntegrationRow,
  PsaConnectionTestDto,
} from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { AppError } from '../../common/problem.filter.js';
import { ValidationFailedException } from '../../common/zod.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService, escapeLike } from '../audit/audit.service.js';
import { PsaAdapterRegistry } from './adapters/registry.js';
import { applianceStatuses, connectionTests } from './psa-connection.js';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const VERSION_SQL = `(extract(epoch FROM i.updated_at) * 1000000)::bigint::text`;

const SORT: Record<string, string> = {
  displayName: 'i.display_name',
  code: 'i.code',
  provider: 'p.name',
  client: 'c.display_name',
  createdAt: 'i.created_at',
  updatedAt: 'i.updated_at',
};

const SELECT = `
  SELECT i.*, ${VERSION_SQL} AS version, p.name AS provider_name, c.code AS client_code, c.display_name AS client_name,
         (SELECT count(*)::int FROM deployments d WHERE d.psa_instance_id = i.id AND d.lifecycle_state <> 'decommissioned') AS dep_count,
         (SELECT count(*)::int FROM psa_instance_services s WHERE s.psa_instance_id = i.id) AS svc_count
  FROM psa_instances i
  JOIN psa_providers p ON p.key = i.provider_key
  JOIN clients c ON c.id = i.client_id`;

function toSummary(r: Row): PsaInstanceSummary {
  return {
    id: r.id as string,
    code: r.code as string,
    displayName: r.display_name as string,
    providerKey: r.provider_key as PsaInstanceSummary['providerKey'],
    providerName: r.provider_name as string,
    client: { id: r.client_id as string, code: r.client_code as string, displayName: r.client_name as string },
    apiEndpoint: (r.api_endpoint as string | null) ?? null,
    authMethod: (r.auth_method as string | null) ?? null,
    status: r.status as PsaInstanceSummary['status'],
    credentialStatus: r.credential_status as PsaInstanceSummary['credentialStatus'],
    connectionStatus: r.connection_status as PsaInstanceSummary['connectionStatus'],
    lastSuccessfulTestAt: iso(r.last_successful_test_at),
    lastSyncAt: iso(r.last_sync_at),
    deploymentCount: r.dep_count as number,
    enabledServiceCount: r.svc_count as number,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    isSynthetic: r.is_synthetic as boolean,
  };
}

@Injectable()
export class PsaService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PsaAdapterRegistry) private readonly adapters: PsaAdapterRegistry,
  ) {}

  providers(): PsaProviderDescriptor[] {
    return this.adapters.all().map((a) => a.descriptor);
  }

  async list(auth: AuthContext, query: PsaInstanceListQuery): Promise<Paged<PsaInstanceSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = p(`%${escapeLike(query.q)}%`);
      where.push(`(i.display_name ILIKE ${like} OR i.code ILIKE ${like} OR c.display_name ILIKE ${like} OR coalesce(i.api_endpoint, '') ILIKE ${like})`);
    }
    if (query.provider) where.push(`i.provider_key = ${p(query.provider)}`);
    if (query.clientId) where.push(`i.client_id = ${p(query.clientId)}`);
    if (query.connectionStatus) where.push(`i.connection_status = ${p(query.connectionStatus)}`);
    if (query.credentialStatus) where.push(`i.credential_status = ${p(query.credentialStatus)}`);
    if (query.status) where.push(`i.status = ${p(query.status)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [field, dir] = (query.sort ?? 'code:asc').split(':') as [string, string];
    const order = `${SORT[field] ?? 'i.code'} ${dir === 'desc' ? 'DESC' : 'ASC'}, i.id`;
    return this.db.tenant(auth, async (q) => {
      const total = await q.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM psa_instances i JOIN psa_providers p ON p.key = i.provider_key JOIN clients c ON c.id = i.client_id ${whereSql}`,
        params,
      );
      const rows = await q.query<Row>(`${SELECT} ${whereSql} ORDER BY ${order} LIMIT ${p(query.pageSize)} OFFSET ${p((query.page - 1) * query.pageSize)}`, params);
      return { items: rows.map(toSummary), page: query.page, pageSize: query.pageSize, total: total.n };
    });
  }

  private async require(q: Queryable, id: string, lock = false): Promise<Row> {
    const r = await q.maybeOne<Row>(`${SELECT} WHERE i.id = $1 ${lock ? 'FOR UPDATE OF i' : ''}`, [id]);
    if (!r) throw new AppError(404, 'not-found', 'PSA instance not found.');
    return r;
  }

  private async detailIn(q: Queryable, id: string): Promise<PsaInstanceDetail> {
    const r = await this.require(q, id);
    const enabled = await q.query<Row>(
      `SELECT s.id, s.key, s.name FROM psa_instance_services pis JOIN services s ON s.id = pis.service_id
       WHERE pis.psa_instance_id = $1 ORDER BY s.sort_order`,
      [id],
    );
    const available = await q.query<Row>(
      `SELECT s.id, s.key, s.name, s.requires_psa FROM client_services cs JOIN services s ON s.id = cs.service_id
       WHERE cs.client_id = $1 ORDER BY s.requires_psa DESC, s.sort_order`,
      [r.client_id],
    );
    const deps = await q.query<Row>(
      `SELECT id, code, lifecycle_state, health_state, psa_instance_id, is_synthetic FROM deployments
       WHERE client_id = $1 AND lifecycle_state <> 'decommissioned' ORDER BY code`,
      [r.client_id],
    );
    const creator = r.created_by ? await q.maybeOne<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [r.created_by]) : null;
    const appliance = (await applianceStatuses(q, [id])).get(id) ?? null;
    return {
      ...toSummary(r),
      appliance,
      config: (r.config as Record<string, string | number | boolean>) ?? {},
      notes: (r.notes as string | null) ?? null,
      enabledServices: enabled.map((s) => ({ id: s.id as string, key: s.key as string, name: s.name as string })),
      availableServices: available.map((s) => ({ id: s.id as string, key: s.key as string, name: s.name as string, requiresPsa: s.requires_psa as boolean })),
      deployments: deps.map((d) => ({
        id: d.id as string, code: d.code as string, lifecycleState: d.lifecycle_state as string, healthState: d.health_state as string,
        boundHere: d.psa_instance_id === id, isSynthetic: d.is_synthetic as boolean,
      })),
      createdBy: creator?.display_name ?? null,
      version: r.version as string,
    };
  }

  async detail(auth: AuthContext, id: string): Promise<PsaInstanceDetail> {
    return this.db.tenant(auth, (q) => this.detailIn(q, id));
  }

  /** Connection tests the appliance(s) bound to this instance reported (Module 11), newest first. */
  async connectionTests(auth: AuthContext, id: string, limit: number): Promise<PsaConnectionTestDto[]> {
    return this.db.tenant(auth, async (q) => {
      await this.require(q, id);
      return connectionTests(q, id, limit);
    });
  }

  /** Fleet view of PSA connections with what each bound appliance last reported. Filters run in SQL. */
  async integrations(auth: AuthContext, query: IntegrationListQuery): Promise<IntegrationRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = p(`%${escapeLike(query.q)}%`);
      where.push(`(i.display_name ILIKE ${like} OR i.code ILIKE ${like} OR c.display_name ILIKE ${like} OR c.code ILIKE ${like})`);
    }
    if (query.provider) where.push(`i.provider_key = ${p(query.provider)}`);
    if (query.connectionStatus) where.push(`i.connection_status = ${p(query.connectionStatus)}`);
    if (query.credentialStatus) where.push(`i.credential_status = ${p(query.credentialStatus)}`);
    if (query.live) where.push('NOT i.is_synthetic');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.tenant(auth, async (q) => {
      const rows = await q.query<Row>(
        `${SELECT} ${whereSql} ORDER BY array_position(ARRAY['failed','untested','succeeded']::text[], i.connection_status), i.is_synthetic, c.display_name, i.code`,
        params,
      );
      const appliances = await applianceStatuses(q, rows.map((r) => r.id as string));
      return rows.map((r) => ({ ...toSummary(r), appliance: appliances.get(r.id as string) ?? null }));
    });
  }

  previewConfig(providerKey: string, authMethod: string, config: unknown) {
    return this.adapters.get(providerKey).parseConfig(config, authMethod);
  }

  /** Validates provider configuration through the adapter. Throws field-level errors. */
  validateConfig(providerKey: string, authMethod: string, config: unknown) {
    const result = this.adapters.get(providerKey).parseConfig(config, authMethod);
    if (!result.ok) throw new ValidationFailedException(result.issues);
    return result;
  }

  private async assertServicesAssigned(q: Queryable, clientId: string, serviceIds: string[]) {
    if (!serviceIds.length) return;
    const rows = await q.query('SELECT 1 FROM client_services WHERE client_id = $1 AND service_id = ANY($2::uuid[])', [clientId, serviceIds]);
    if (rows.length !== serviceIds.length) {
      throw new ValidationFailedException([{ path: 'enabledServiceIds', message: 'Only services assigned to this client can be enabled on its PSA instance.' }]);
    }
  }

  private async setEnabledServices(q: Queryable, orgId: string, clientId: string, instanceId: string, serviceIds: string[], userId: string) {
    await q.query('DELETE FROM psa_instance_services WHERE psa_instance_id = $1 AND NOT (service_id = ANY($2::uuid[]))', [instanceId, serviceIds]);
    for (const s of serviceIds) {
      await q.query(
        `INSERT INTO psa_instance_services (organization_id, client_id, psa_instance_id, service_id, enabled_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [orgId, clientId, instanceId, s, userId],
      );
    }
  }

  /** Used by onboarding completion and by the create endpoint. Must run inside a tenant transaction. */
  async insertInstance(
    q: Queryable,
    auth: AuthContext,
    input: { clientId: string; providerKey: string; displayName: string; authMethod: string; config: unknown; notes?: string; enabledServiceIds: string[] },
  ): Promise<{ id: string; code: string; endpoint: string }> {
    const { config, endpoint } = this.validateConfig(input.providerKey, input.authMethod, input.config);
    await this.assertServicesAssigned(q, input.clientId, input.enabledServiceIds);
    const id = randomUUID();
    try {
      await q.query(
        `INSERT INTO psa_instances (id, organization_id, client_id, code, provider_key, display_name, api_endpoint, auth_method, config, notes,
           credential_status, connection_status, created_by)
         VALUES ($1, $2, $3, next_org_code('psa_instance', 'PSA'), $4, $5, $6, $7, $8, $9, 'pending_appliance', 'untested', $10)`,
        [id, auth.orgId, input.clientId, input.providerKey, input.displayName, endpoint, input.authMethod, JSON.stringify(config), input.notes ?? null, auth.userId],
      );
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).code === '23505') {
        throw new ValidationFailedException([{ path: 'displayName', message: 'This client already has a PSA instance with this name.' }]);
      }
      throw err;
    }
    await this.setEnabledServices(q, auth.orgId, input.clientId, id, input.enabledServiceIds, auth.userId);
    const { code } = await q.one<{ code: string }>('SELECT code FROM psa_instances WHERE id = $1', [id]);
    return { id, code, endpoint };
  }

  private async actor(q: Queryable, auth: AuthContext) {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  async create(auth: AuthContext, dto: PsaInstanceCreate, meta: RequestMeta): Promise<PsaInstanceDetail> {
    return this.db.tenant(auth, async (q) => {
      const client = await q.maybeOne<{ status: string; display_name: string }>('SELECT status, display_name FROM clients WHERE id = $1', [dto.clientId]);
      if (!client) throw new ValidationFailedException([{ path: 'clientId', message: 'Choose a client you have access to.' }]);
      if (client.status === 'offboarded') throw new ValidationFailedException([{ path: 'clientId', message: 'Offboarded clients cannot get new PSA instances.' }]);
      const created = await this.insertInstance(q, auth, dto);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'psa_instance.created', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth),
        meta, targetType: 'psa_instance', targetId: created.id, targetDisplay: dto.displayName, clientId: dto.clientId,
        metadata: { code: created.code, provider: dto.providerKey, authMethod: dto.authMethod, endpoint: created.endpoint, connectionStatus: 'untested' },
      });
      return this.detailIn(q, created.id);
    });
  }

  async update(auth: AuthContext, id: string, dto: PsaInstanceUpdate, meta: RequestMeta): Promise<PsaInstanceDetail> {
    return this.db.tenant(auth, async (q) => {
      const before = await this.require(q, id, true);
      if (before.version !== dto.version) {
        throw new AppError(409, 'stale-version', 'This PSA instance was changed by someone else after you opened it. Reload to see the latest version.');
      }
      const { config, endpoint } = this.validateConfig(before.provider_key as string, dto.authMethod, dto.config);
      await this.assertServicesAssigned(q, before.client_id as string, dto.enabledServiceIds);
      if (dto.status === 'disabled' && before.status !== 'disabled') {
        const bound = await q.query<{ code: string }>(
          `SELECT code FROM deployments WHERE psa_instance_id = $1 AND lifecycle_state <> 'decommissioned'`,
          [id],
        );
        if (bound.length) {
          throw new AppError(409, 'instance-in-use', `This instance is used by ${bound.map((b) => b.code).join(', ')}. Associate those deployments with another PSA instance first.`);
        }
      }
      // Changing how the instance connects invalidates any earlier test result.
      const connectionChanged = endpoint !== before.api_endpoint || dto.authMethod !== before.auth_method;
      try {
        await q.query(
          `UPDATE psa_instances SET display_name = $2, auth_method = $3, config = $4, api_endpoint = $5, notes = $6, status = $7,
             connection_status = CASE WHEN $8 THEN 'untested' ELSE connection_status END,
             last_successful_test_at = CASE WHEN $8 THEN NULL ELSE last_successful_test_at END
           WHERE id = $1`,
          [id, dto.displayName, dto.authMethod, JSON.stringify(config), endpoint, dto.notes ?? null, dto.status, connectionChanged],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ValidationFailedException([{ path: 'displayName', message: 'This client already has a PSA instance with this name.' }]);
        throw err;
      }
      const beforeServices = (await q.query<{ service_id: string }>('SELECT service_id FROM psa_instance_services WHERE psa_instance_id = $1', [id])).map((r) => r.service_id);
      await this.setEnabledServices(q, auth.orgId, before.client_id as string, id, dto.enabledServiceIds, auth.userId);

      const prevConfig = (before.config as Record<string, unknown>) ?? {};
      const configChanges = Object.fromEntries(
        [...new Set([...Object.keys(prevConfig), ...Object.keys(config)])]
          .filter((k) => JSON.stringify(prevConfig[k] ?? null) !== JSON.stringify(config[k] ?? null))
          .map((k) => [k, { from: prevConfig[k] ?? null, to: config[k] ?? null }]),
      );
      const changes: Record<string, unknown> = {};
      if (dto.displayName !== before.display_name) changes.displayName = { from: before.display_name, to: dto.displayName };
      if (dto.authMethod !== before.auth_method) changes.authMethod = { from: before.auth_method, to: dto.authMethod };
      if (endpoint !== before.api_endpoint) changes.apiEndpoint = { from: before.api_endpoint, to: endpoint };
      if (Object.keys(configChanges).length) changes.config = configChanges;
      if ((dto.notes ?? null) !== (before.notes ?? null)) changes.notes = { changed: true };
      if (dto.status !== before.status) changes.status = { from: before.status, to: dto.status };
      if ([...beforeServices].sort().join() !== [...dto.enabledServiceIds].sort().join()) changes.enabledServices = { count: dto.enabledServiceIds.length };
      if (connectionChanged && before.connection_status !== 'untested') changes.connectionStatus = { from: before.connection_status, to: 'untested' };

      if (Object.keys(changes).length) {
        await this.audit.write(q, {
          orgId: auth.orgId, action: changes.status ? `psa_instance.${dto.status === 'disabled' ? 'disabled' : 'enabled'}` : 'psa_instance.updated',
          outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta, targetType: 'psa_instance', targetId: id,
          targetDisplay: dto.displayName, clientId: before.client_id as string, metadata: { code: before.code, changes },
        });
      }
      return this.detailIn(q, id);
    });
  }

  /** Associates a deployment with one of its client's active PSA instances. */
  async bindDeployment(auth: AuthContext, deploymentId: string, psaInstanceId: string, meta: RequestMeta) {
    return this.db.tenant(auth, async (q) => {
      const dep = await q.maybeOne<Row>(
        `SELECT d.id, d.code, d.client_id, d.lifecycle_state, i.code AS old_code FROM deployments d
         LEFT JOIN psa_instances i ON i.id = d.psa_instance_id WHERE d.id = $1 FOR UPDATE OF d`,
        [deploymentId],
      );
      if (!dep) throw new AppError(404, 'not-found', 'Deployment not found.');
      if (dep.lifecycle_state === 'decommissioned') throw new AppError(409, 'decommissioned', 'Decommissioned deployments cannot be changed.');
      const inst = await q.maybeOne<Row>('SELECT id, code, client_id, status FROM psa_instances WHERE id = $1', [psaInstanceId]);
      if (!inst || inst.client_id !== dep.client_id) {
        throw new ValidationFailedException([{ path: 'psaInstanceId', message: 'Choose a PSA instance that belongs to the same client.' }]);
      }
      if (inst.status !== 'active') throw new ValidationFailedException([{ path: 'psaInstanceId', message: 'Disabled PSA instances cannot be used by deployments.' }]);
      if (dep.old_code === inst.code) return { deploymentId, psaInstanceId, changed: false };
      await q.query('UPDATE deployments SET psa_instance_id = $2 WHERE id = $1', [deploymentId, psaInstanceId]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.psa_instance.changed', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth),
        meta, targetType: 'deployment', targetId: deploymentId, targetDisplay: dep.code as string, clientId: dep.client_id as string,
        metadata: { from: dep.old_code ?? null, to: inst.code },
      });
      return { deploymentId, psaInstanceId, changed: true };
    });
  }

  async activity(auth: AuthContext, id: string, page: number, pageSize: number): Promise<Paged<AuditEventDto>> {
    return this.db.tenant(auth, async (q) => {
      const inst = await this.require(q, id);
      const filter = `client_id = $1 AND ((target_type = 'psa_instance' AND target_id = $2) OR (action = 'deployment.psa_instance.changed' AND (metadata->>'to' = $3 OR metadata->>'from' = $3)))`;
      const params = [inst.client_id, id, inst.code];
      const total = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE ${filter}`, params);
      const rows = await q.query<Row>(
        `SELECT id, occurred_at, actor_type, actor_user_id, actor_display, action, target_type, target_id, target_display, outcome,
                host(ip) AS ip, request_id, metadata
         FROM audit_events WHERE ${filter} ORDER BY occurred_at DESC LIMIT $4 OFFSET $5`,
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
}
