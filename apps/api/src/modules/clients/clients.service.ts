import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditEventDto,
  type AuditOutcome,
  type ClientDeploymentDto,
  type ClientDetail,
  type ClientHealthDto,
  type ClientListQuery,
  type ClientPsaInstanceDto,
  type ClientServiceDto,
  type ClientServicesUpdate,
  type ClientSummary,
  checkServiceConfig,
  type ConfigRequirement,
  type ServiceConfigValues,
  type ClientUpdateRequest,
  type ContactDto,
  type ContactInput,
  type DuplicateCheckResponse,
  HEALTH_STATES,
  type HealthState,
  type Paged,
  type UserRef,
} from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { AppError } from '../../common/problem.filter.js';
import { ValidationFailedException } from '../../common/zod.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService, escapeLike } from '../audit/audit.service.js';
import { serviceDto } from '../services/services.service.js';

type Row = Record<string, unknown>;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const isoDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v : null);
const ref = (id: unknown, name: unknown, email?: unknown): UserRef | null =>
  id ? { id: id as string, displayName: name as string, ...(email ? { email: email as string } : {}) } : null;

function emptyHealth(): Record<HealthState, number> {
  return Object.fromEntries(HEALTH_STATES.map((s) => [s, 0])) as Record<HealthState, number>;
}

const SORT: Record<string, string> = {
  displayName: 'c.display_name',
  code: 'c.code',
  clientReference: 'lower(c.client_reference)',
  status: 'c.status',
  createdAt: 'c.created_at',
  onboardingDate: 'c.onboarding_date',
  country: 'c.country_code',
};

/** Version token = updated_at in microseconds (stable across JS Date precision loss). */
export const VERSION_SQL = `(extract(epoch FROM c.updated_at) * 1000000)::bigint::text`;

const SUMMARY_SELECT = `
  SELECT c.*, ${VERSION_SQL} AS version,
         am.display_name AS am_name, am.email AS am_email,
         coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('key', p.key, 'name', p.name))
                   FROM psa_instances i JOIN psa_providers p ON p.key = i.provider_key WHERE i.client_id = c.id), '[]') AS psa,
         (SELECT count(*)::int FROM deployments d WHERE d.client_id = c.id AND d.lifecycle_state <> 'decommissioned') AS dep_count,
         (SELECT jsonb_object_agg(h.health_state, h.n) FROM (
            SELECT d.health_state, count(*)::int AS n FROM deployments d
            WHERE d.client_id = c.id AND d.lifecycle_state <> 'decommissioned' GROUP BY d.health_state) h) AS health
  FROM clients c
  LEFT JOIN users am ON am.id = c.account_manager_user_id`;

function toSummary(r: Row): ClientSummary {
  return {
    id: r.id as string,
    code: r.code as string,
    displayName: r.display_name as string,
    legalName: r.legal_name as string,
    clientReference: r.client_reference as string,
    status: r.status as ClientSummary['status'],
    serviceStatus: r.service_status as ClientSummary['serviceStatus'],
    businessType: (r.business_type as string | null) ?? null,
    countryCode: (r.country_code as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    psaProviders: (r.psa as ClientSummary['psaProviders']).sort((a, b) => a.name.localeCompare(b.name)),
    deploymentCount: r.dep_count as number,
    health: { ...emptyHealth(), ...((r.health as Record<HealthState, number> | null) ?? {}) },
    accountManager: ref(r.account_manager_user_id, r.am_name, r.am_email),
    onboardingDate: isoDate(r.onboarding_date),
    createdAt: iso(r.created_at)!,
    isSynthetic: r.is_synthetic as boolean,
  };
}

export function toContact(r: Row): ContactDto {
  return {
    id: r.id as string,
    fullName: r.full_name as string,
    jobTitle: (r.job_title as string | null) ?? null,
    email: r.email as string,
    phone: (r.phone as string | null) ?? null,
    mobile: (r.mobile as string | null) ?? null,
    roles: r.roles as ContactDto['roles'],
    notes: (r.notes as string | null) ?? null,
    isSynthetic: r.is_synthetic as boolean,
    updatedAt: iso(r.updated_at)!,
  };
}

function toDeployment(r: Row): ClientDeploymentDto {
  return {
    id: r.id as string,
    code: r.code as string,
    psaInstanceCode: (r.psa_code as string | null) ?? null,
    targetEnvironment: r.target_environment as string,
    targetOs: (r.target_os as string | null) ?? null,
    targetArch: (r.target_arch as string | null) ?? null,
    hostLabel: (r.host_label as string | null) ?? null,
    lifecycleState: r.lifecycle_state as ClientDeploymentDto['lifecycleState'],
    healthState: r.health_state as HealthState,
    healthReason: (r.health_reason as string | null) ?? null,
    imageVersion: (r.image_version as string | null) ?? null,
    lastHeartbeatAt: iso(r.last_heartbeat_at),
    enrolledAt: iso(r.enrolled_at),
    createdAt: iso(r.created_at)!,
    isSynthetic: r.is_synthetic as boolean,
  };
}

const CONTACT_COLS = 'id, full_name, job_title, email, phone, mobile, roles, notes, is_synthetic, updated_at';

@Injectable()
export class ClientsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Directory & detail
  // ---------------------------------------------------------------------------
  async list(auth: AuthContext, query: ClientListQuery): Promise<Paged<ClientSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = p(`%${escapeLike(query.q)}%`);
      where.push(`(c.display_name ILIKE ${like} OR c.legal_name ILIKE ${like} OR c.client_reference ILIKE ${like} OR c.code ILIKE ${like} OR c.city ILIKE ${like})`);
    }
    if (query.status) where.push(`c.status = ${p(query.status)}`);
    if (query.serviceStatus) where.push(`c.service_status = ${p(query.serviceStatus)}`);
    if (query.country) where.push(`c.country_code = ${p(query.country)}`);
    if (query.accountManager) where.push(`c.account_manager_user_id = ${p(query.accountManager)}`);
    if (query.provider) where.push(`EXISTS (SELECT 1 FROM psa_instances i WHERE i.client_id = c.id AND i.provider_key = ${p(query.provider)})`);
    if (query.health) where.push(`EXISTS (SELECT 1 FROM deployments d WHERE d.client_id = c.id AND d.health_state = ${p(query.health)} AND d.lifecycle_state <> 'decommissioned')`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [field, dir] = (query.sort ?? 'displayName:asc').split(':') as [string, string];
    const order = `${SORT[field] ?? 'c.display_name'} ${dir === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS LAST'}, c.id`;

    return this.db.tenant(auth, async (q) => {
      const total = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM clients c ${whereSql}`, params);
      const rows = await q.query<Row>(`${SUMMARY_SELECT} ${whereSql} ORDER BY ${order} LIMIT ${p(query.pageSize)} OFFSET ${p((query.page - 1) * query.pageSize)}`, params);
      return { items: rows.map(toSummary), page: query.page, pageSize: query.pageSize, total: total.n };
    });
  }

  async requireClient(q: Queryable, id: string): Promise<Row> {
    const row = await q.maybeOne<Row>(`${SUMMARY_SELECT} WHERE c.id = $1`, [id]);
    if (!row) throw new AppError(404, 'not-found', 'Client not found.');
    return row;
  }

  async detail(auth: AuthContext, id: string): Promise<ClientDetail> {
    return this.db.tenant(auth, (q) => this.detailIn(q, id));
  }

  private async detailIn(q: Queryable, id: string): Promise<ClientDetail> {
    const r = await this.requireClient(q, id);
    const extra = await q.one<Row>(
      `SELECT tech.display_name AS tech_name, tech.email AS tech_email, cb.display_name AS cb_name,
              (SELECT count(*)::int FROM client_contacts WHERE client_id = $1) AS contacts,
              (SELECT count(*)::int FROM client_services WHERE client_id = $1) AS services,
              (SELECT count(*)::int FROM psa_instances WHERE client_id = $1) AS psa
       FROM clients c
       LEFT JOIN users tech ON tech.id = c.technical_owner_user_id
       LEFT JOIN users cb ON cb.id = c.created_by
       WHERE c.id = $1`,
      [id],
    );
    const primary = await q.maybeOne<Row>(`SELECT ${CONTACT_COLS} FROM client_contacts WHERE client_id = $1 AND is_primary`, [id]);
    const technicians = await q.query<Row>(
      `SELECT u.id, u.display_name, u.email FROM user_client_assignments a JOIN users u ON u.id = a.user_id
       WHERE a.client_id = $1 ORDER BY u.display_name`,
      [id],
    );
    return {
      ...toSummary(r),
      stateRegion: (r.state_region as string | null) ?? null,
      timezone: r.timezone as string,
      website: (r.website as string | null) ?? null,
      technicalOwner: ref(r.technical_owner_user_id, extra.tech_name, extra.tech_email),
      contractStartDate: isoDate(r.contract_start_date),
      contractEndDate: isoDate(r.contract_end_date),
      internalNotes: (r.internal_notes as string | null) ?? null,
      primaryContact: primary ? toContact(primary) : null,
      counts: {
        contacts: extra.contacts as number,
        services: extra.services as number,
        psaInstances: extra.psa as number,
        deployments: r.dep_count as number,
      },
      assignedTechnicians: technicians.map((t) => ref(t.id, t.display_name, t.email)!),
      createdBy: ref(r.created_by, extra.cb_name),
      updatedAt: iso(r.updated_at)!,
      version: r.version as string,
    };
  }

  // ---------------------------------------------------------------------------
  // Update (optimistic concurrency) & duplicate detection
  // ---------------------------------------------------------------------------
  async assertActiveUsers(q: Queryable, ids: (string | undefined)[], paths: string[]) {
    const issues: { path: string; message: string }[] = [];
    for (const [i, id] of ids.entries()) {
      if (!id) continue;
      const u = await q.maybeOne<{ status: string }>('SELECT status FROM users WHERE id = $1', [id]);
      if (!u || u.status !== 'active') issues.push({ path: paths[i]!, message: 'Choose an active user from your organization.' });
    }
    if (issues.length) throw new ValidationFailedException(issues);
  }

  /**
   * Client references are unique across the organization, so the check briefly lifts the caller's
   * client scope (still inside the organization's RLS boundary) and then restores it.
   * Only the conflicting client's code is revealed.
   */
  async referenceTakenBy(q: Queryable, auth: AuthContext, reference: string, excludeId?: string): Promise<{ id: string; code: string } | null> {
    if (!auth.scopeAll) await q.query(`SELECT set_config('app.scope_all', 'on', true)`);
    try {
      return await q.maybeOne<{ id: string; code: string }>(
        `SELECT id, code FROM clients WHERE lower(client_reference) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [reference, excludeId ?? null],
      );
    } finally {
      if (!auth.scopeAll) await q.query(`SELECT set_config('app.scope_all', 'off', true)`);
    }
  }

  async duplicateCheck(auth: AuthContext, input: { reference?: string; legalName?: string; displayName?: string; excludeId?: string }): Promise<DuplicateCheckResponse> {
    return this.db.tenant(auth, async (q) => {
      const taken = input.reference ? await this.referenceTakenBy(q, auth, input.reference, input.excludeId) : null;
      const names = [input.legalName, input.displayName].filter((n): n is string => !!n && n.length >= 3);
      const similar = names.length
        ? await q.query<Row>(
            `SELECT c.id, c.code, c.display_name, c.legal_name, s.score
             FROM clients c
             CROSS JOIN LATERAL (
               SELECT max(greatest(similarity(c.display_name, n), similarity(c.legal_name, n))) AS score FROM unnest($1::text[]) AS n
             ) s
             WHERE ($2::uuid IS NULL OR c.id <> $2::uuid) AND s.score > 0.45
             ORDER BY s.score DESC, c.code LIMIT 5`,
            [names, input.excludeId ?? null],
          )
        : [];
      return {
        referenceAvailable: input.reference ? !taken : null,
        similar: similar.map((s) => ({ id: s.id as string, code: s.code as string, displayName: s.display_name as string, legalName: s.legal_name as string })),
      };
    });
  }

  async update(auth: AuthContext, id: string, dto: ClientUpdateRequest, meta: RequestMeta): Promise<ClientDetail> {
    return this.db.tenant(auth, async (q) => {
      const before = await this.requireClient(q, id);
      if (before.version !== dto.version) {
        throw new AppError(409, 'stale-version', 'This client was changed by someone else after you opened it. Reload to see the latest version, then reapply your changes.');
      }
      const { company: c, management: m } = dto;
      await this.assertActiveUsers(q, [m.accountManagerUserId, m.technicalOwnerUserId], ['management.accountManagerUserId', 'management.technicalOwnerUserId']);
      const taken = await this.referenceTakenBy(q, auth, c.clientReference, id);
      if (taken) throw new ValidationFailedException([{ path: 'company.clientReference', message: `This reference is already used by ${taken.code}.` }]);

      const next: Record<string, unknown> = {
        legal_name: c.legalName, display_name: c.displayName, client_reference: c.clientReference, business_type: c.businessType,
        country_code: c.countryCode, state_region: c.stateRegion ?? null, city: c.city ?? null, timezone: c.timezone, website: c.website ?? null,
        account_manager_user_id: m.accountManagerUserId ?? null, technical_owner_user_id: m.technicalOwnerUserId ?? null,
        onboarding_date: m.onboardingDate ?? null, contract_start_date: m.contractStartDate ?? null, contract_end_date: m.contractEndDate ?? null,
        internal_notes: m.internalNotes ?? null, status: dto.status, service_status: dto.serviceStatus,
      };
      const norm = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null));
      const changed = Object.keys(next).filter((k) => String(norm(before[k])) !== String(next[k] ?? null));
      if (!changed.length) return this.detailIn(q, id);

      const cols = Object.keys(next);
      try {
        await q.query(
          `UPDATE clients c SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE c.id = $1 AND ${VERSION_SQL} = $${cols.length + 2}`,
          [id, ...cols.map((k) => next[k]), dto.version],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ValidationFailedException([{ path: 'company.clientReference', message: 'This reference is already in use.' }]);
        throw err;
      }
      const diff = Object.fromEntries(
        changed.map((k) => [k, k === 'internal_notes' ? { changed: true } : { from: norm(before[k]), to: next[k] ?? null }]),
      );
      await this.audit.write(q, {
        orgId: auth.orgId, action: dto.status !== before.status ? 'client.status.changed' : 'client.updated', outcome: 'success',
        actorUserId: auth.userId, actorDisplay: await this.email(q, auth), meta, targetType: 'client', targetId: id,
        targetDisplay: c.displayName, clientId: id, metadata: { changes: diff },
      });
      return this.detailIn(q, id);
    });
  }

  private async email(q: Queryable, auth: AuthContext) {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------
  async contacts(auth: AuthContext, clientId: string): Promise<ContactDto[]> {
    return this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const rows = await q.query<Row>(`SELECT ${CONTACT_COLS} FROM client_contacts WHERE client_id = $1 ORDER BY is_primary DESC, full_name`, [clientId]);
      return rows.map(toContact);
    });
  }

  /** Inserts contacts for a client, demoting any existing primary when a new one is marked primary. */
  async insertContacts(q: Queryable, orgId: string, clientId: string, list: ContactInput[], userId: string, synthetic = false): Promise<string[]> {
    const ids: string[] = [];
    for (const c of list) {
      const id = randomUUID();
      if (c.roles.includes('primary')) await this.demotePrimary(q, clientId);
      try {
        await q.query(
          `INSERT INTO client_contacts (id, organization_id, client_id, full_name, job_title, email, phone, mobile, roles, notes, is_synthetic, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [id, orgId, clientId, c.fullName, c.jobTitle ?? null, c.email, c.phone ?? null, c.mobile ?? null, c.roles, c.notes ?? null, synthetic, userId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new AppError(409, 'duplicate-contact-email', `A contact with the email ${c.email} already exists for this client.`);
        throw err;
      }
      ids.push(id);
    }
    return ids;
  }

  private async demotePrimary(q: Queryable, clientId: string, exceptId?: string) {
    await q.query(
      `UPDATE client_contacts
       SET roles = CASE WHEN cardinality(array_remove(roles, 'primary')) = 0 THEN ARRAY['other'] ELSE array_remove(roles, 'primary') END
       WHERE client_id = $1 AND is_primary AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [clientId, exceptId ?? null],
    );
  }

  async createContact(auth: AuthContext, clientId: string, dto: ContactInput, meta: RequestMeta): Promise<ContactDto> {
    return this.db.tenant(auth, async (q) => {
      const client = await this.requireClient(q, clientId);
      const hasPrimary = await q.maybeOne(`SELECT 1 FROM client_contacts WHERE client_id = $1 AND is_primary`, [clientId]);
      const input = !hasPrimary && !dto.roles.includes('primary') ? { ...dto, roles: ['primary' as const, ...dto.roles] } : dto;
      const [id] = await this.insertContacts(q, auth.orgId, clientId, [input], auth.userId);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'client.contact.created', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.email(q, auth),
        meta, targetType: 'contact', targetId: id, targetDisplay: dto.fullName, clientId,
        metadata: { roles: input.roles, client: client.code },
      });
      return toContact(await q.one<Row>(`SELECT ${CONTACT_COLS} FROM client_contacts WHERE id = $1`, [id]));
    });
  }

  async updateContact(auth: AuthContext, clientId: string, contactId: string, dto: ContactInput, meta: RequestMeta): Promise<ContactDto> {
    return this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const before = await q.maybeOne<Row>(`SELECT ${CONTACT_COLS}, is_primary FROM client_contacts WHERE id = $1 AND client_id = $2 FOR UPDATE`, [contactId, clientId]);
      if (!before) throw new AppError(404, 'not-found', 'Contact not found.');
      if (before.is_primary && !dto.roles.includes('primary')) {
        throw new ValidationFailedException([{ path: 'roles', message: 'A client must have a primary contact. Mark another contact as primary instead.' }]);
      }
      if (!before.is_primary && dto.roles.includes('primary')) await this.demotePrimary(q, clientId, contactId);
      try {
        await q.query(
          `UPDATE client_contacts SET full_name = $3, job_title = $4, email = $5, phone = $6, mobile = $7, roles = $8, notes = $9
           WHERE id = $1 AND client_id = $2`,
          [contactId, clientId, dto.fullName, dto.jobTitle ?? null, dto.email, dto.phone ?? null, dto.mobile ?? null, dto.roles, dto.notes ?? null],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new AppError(409, 'duplicate-contact-email', `A contact with the email ${dto.email} already exists for this client.`);
        throw err;
      }
      const fields = ['full_name', 'job_title', 'email', 'phone', 'mobile', 'roles', 'notes'].filter((k) => {
        const map: Record<string, unknown> = { full_name: dto.fullName, job_title: dto.jobTitle, email: dto.email, phone: dto.phone, mobile: dto.mobile, roles: dto.roles, notes: dto.notes };
        return JSON.stringify(before[k] ?? null) !== JSON.stringify(map[k] ?? null);
      });
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'client.contact.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.email(q, auth),
        meta, targetType: 'contact', targetId: contactId, targetDisplay: dto.fullName, clientId, metadata: { fields },
      });
      return toContact(await q.one<Row>(`SELECT ${CONTACT_COLS} FROM client_contacts WHERE id = $1`, [contactId]));
    });
  }

  async deleteContact(auth: AuthContext, clientId: string, contactId: string, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const c = await q.maybeOne<Row>('SELECT full_name, is_primary FROM client_contacts WHERE id = $1 AND client_id = $2 FOR UPDATE', [contactId, clientId]);
      if (!c) throw new AppError(404, 'not-found', 'Contact not found.');
      if (c.is_primary) throw new AppError(409, 'primary-contact', 'The primary contact cannot be removed. Mark another contact as primary first.');
      const n = await q.one<{ n: number }>('SELECT count(*)::int AS n FROM client_contacts WHERE client_id = $1', [clientId]);
      if (n.n <= 1) throw new AppError(409, 'last-contact', 'A client must keep at least one contact.');
      await q.query('DELETE FROM client_contacts WHERE id = $1', [contactId]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'client.contact.deleted', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.email(q, auth),
        meta, targetType: 'contact', targetId: contactId, targetDisplay: c.full_name as string, clientId,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------
  async clientServices(auth: AuthContext, clientId: string): Promise<ClientServiceDto[]> {
    return this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const rows = await q.query<Row>(
        `SELECT s.*, sc.id AS cat_id, sc.key AS cat_key, sc.name AS cat_name, cs.config, cs.enabled_at, eu.display_name AS enabled_by_name
         FROM client_services cs JOIN services s ON s.id = cs.service_id JOIN service_categories sc ON sc.id = s.category_id
         LEFT JOIN users eu ON eu.id = cs.enabled_by
         WHERE cs.client_id = $1 ORDER BY sc.sort_order, s.sort_order`,
        [clientId],
      );
      return rows.map((r) => {
        const dto = serviceDto(r);
        const checked = checkServiceConfig(dto.configRequirements, r.config as Record<string, unknown>);
        return { ...dto, enabledAt: iso(r.enabled_at)!, enabledBy: (r.enabled_by_name as string | null) ?? null, config: checked.config, configIssues: checked.issues };
      });
    });
  }

  async assertActiveServices(q: Queryable, ids: string[], path = 'serviceIds'): Promise<{ id: string; key: string }[]> {
    if (!ids.length) return [];
    const rows = await q.query<{ id: string; key: string }>('SELECT id, key FROM services WHERE id = ANY($1::uuid[]) AND is_active', [ids]);
    if (rows.length !== ids.length) throw new ValidationFailedException([{ path, message: 'One or more selected services are unavailable or inactive.' }]);
    return rows;
  }

  /**
   * Validates the values supplied for each service's configuration requirements (catalog, Module 4) and returns the
   * normalized values per service id. Services without an entry fall back to `current` (their stored values) or `{}`.
   * Required settings that are missing fail validation with paths `config.<serviceId>.<key>`.
   */
  async serviceConfigsFor(
    q: Queryable,
    serviceIds: string[],
    config: Record<string, Record<string, unknown>>,
    current: Map<string, Record<string, unknown>> = new Map(),
  ): Promise<Map<string, ServiceConfigValues>> {
    const out = new Map<string, ServiceConfigValues>();
    if (!serviceIds.length) return out;
    const rows = await q.query<{ id: string; config_requirements: ConfigRequirement[] }>('SELECT id, config_requirements FROM services WHERE id = ANY($1::uuid[])', [serviceIds]);
    const issues: { path: string; message: string }[] = [];
    for (const r of rows) {
      const checked = checkServiceConfig(r.config_requirements ?? [], config[r.id] ?? current.get(r.id) ?? {});
      for (const i of checked.issues) issues.push({ path: `config.${r.id}.${i.path}`, message: i.message });
      out.set(r.id, checked.config);
    }
    if (issues.length) throw new ValidationFailedException(issues);
    return out;
  }

  async setClientServices(auth: AuthContext, clientId: string, dto: ClientServicesUpdate, meta: RequestMeta): Promise<ClientServiceDto[]> {
    const { serviceIds } = dto;
    await this.db.tenant(auth, async (q) => {
      const client = await this.requireClient(q, clientId);
      const current = await q.query<{ service_id: string; key: string; config: Record<string, unknown> }>(
        'SELECT cs.service_id, s.key, cs.config FROM client_services cs JOIN services s ON s.id = cs.service_id WHERE cs.client_id = $1',
        [clientId],
      );
      // Only newly assigned services must be active: a deactivated service keeps its existing assignments.
      const addedIds = serviceIds.filter((id) => !current.some((c) => c.service_id === id));
      const keptIds = serviceIds.filter((id) => current.some((c) => c.service_id === id));
      const added = await this.assertActiveServices(q, addedIds);
      const configs = await this.serviceConfigsFor(q, serviceIds, dto.config, new Map(current.map((c) => [c.service_id, c.config])));
      const removed = current.filter((c) => !serviceIds.includes(c.service_id));
      const configured: string[] = [];
      for (const id of keptIds) {
        const c = current.find((x) => x.service_id === id)!;
        const next = configs.get(id) ?? {};
        if (JSON.stringify(c.config ?? {}) !== JSON.stringify(next)) {
          await q.query('UPDATE client_services SET config = $3 WHERE client_id = $1 AND service_id = $2', [clientId, id, JSON.stringify(next)]);
          configured.push(c.key);
        }
      }
      if (!added.length && !removed.length && !configured.length) return;
      if (removed.length) await q.query('DELETE FROM client_services WHERE client_id = $1 AND service_id = ANY($2::uuid[])', [clientId, removed.map((r) => r.service_id)]);
      for (const s of added) {
        await q.query('INSERT INTO client_services (organization_id, client_id, service_id, config, enabled_by) VALUES ($1, $2, $3, $4, $5)', [
          auth.orgId, clientId, s.id, JSON.stringify(configs.get(s.id) ?? {}), auth.userId,
        ]);
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'client.services.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.email(q, auth),
        meta, targetType: 'client', targetId: clientId, targetDisplay: client.display_name as string, clientId,
        metadata: { added: added.map((a) => a.key), removed: removed.map((r) => r.key), configured },
      });
    });
    return this.clientServices(auth, clientId);
  }

  // ---------------------------------------------------------------------------
  // Sub-resources: PSA instances, deployments, health, activity
  // ---------------------------------------------------------------------------
  async psaInstances(auth: AuthContext, clientId: string): Promise<ClientPsaInstanceDto[]> {
    return this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const rows = await q.query<Row>(
        `SELECT i.*, p.name AS provider_name FROM psa_instances i JOIN psa_providers p ON p.key = i.provider_key
         WHERE i.client_id = $1 ORDER BY i.code`,
        [clientId],
      );
      return rows.map((r) => ({
        id: r.id as string, code: r.code as string, providerKey: r.provider_key as ClientPsaInstanceDto['providerKey'],
        providerName: r.provider_name as string, displayName: r.display_name as string, apiEndpoint: (r.api_endpoint as string | null) ?? null,
        authMethod: (r.auth_method as string | null) ?? null, credentialStatus: r.credential_status as string,
        connectionStatus: r.connection_status as ClientPsaInstanceDto['connectionStatus'], lastSuccessfulTestAt: iso(r.last_successful_test_at),
        createdAt: iso(r.created_at)!, isSynthetic: r.is_synthetic as boolean,
      }));
    });
  }

  async deployments(auth: AuthContext, clientId: string): Promise<ClientDeploymentDto[]> {
    return this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const rows = await q.query<Row>(
        `SELECT d.*, i.code AS psa_code FROM deployments d LEFT JOIN psa_instances i ON i.id = d.psa_instance_id
         WHERE d.client_id = $1 ORDER BY d.created_at DESC`,
        [clientId],
      );
      return rows.map(toDeployment);
    });
  }

  async health(auth: AuthContext, clientId: string): Promise<ClientHealthDto> {
    return this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const deps = await q.query<Row>(
        `SELECT d.*, i.code AS psa_code FROM deployments d LEFT JOIN psa_instances i ON i.id = d.psa_instance_id
         WHERE d.client_id = $1 AND d.lifecycle_state <> 'decommissioned' ORDER BY d.code`,
        [clientId],
      );
      const events = await q.query<Row>(
        `SELECT d.code, e.health_state, e.reason, e.source, e.observed_at FROM deployment_health_events e
         JOIN deployments d ON d.id = e.deployment_id
         WHERE e.client_id = $1 AND e.observed_at > now() - interval '30 days'
         ORDER BY e.observed_at DESC LIMIT 100`,
        [clientId],
      );
      const summary = emptyHealth();
      for (const d of deps) summary[d.health_state as HealthState]++;
      return {
        summary,
        deployments: deps.map(toDeployment),
        events: events.map((e) => ({
          deploymentCode: e.code as string, healthState: e.health_state as HealthState, reason: (e.reason as string | null) ?? null,
          source: e.source as 'agent' | 'system' | 'synthetic', observedAt: iso(e.observed_at)!,
        })),
      };
    });
  }

  async activity(auth: AuthContext, clientId: string, page: number, pageSize: number): Promise<Paged<AuditEventDto>> {
    return this.db.tenant(auth, async (q) => {
      await this.requireClient(q, clientId);
      const total = await q.one<{ n: number }>('SELECT count(*)::int AS n FROM audit_events WHERE client_id = $1', [clientId]);
      const rows = await q.query<Row>(
        `SELECT id, occurred_at, actor_type, actor_user_id, actor_display, action, target_type, target_id, target_display,
                outcome, host(ip) AS ip, request_id, metadata
         FROM audit_events WHERE client_id = $1 ORDER BY occurred_at DESC, id LIMIT $2 OFFSET $3`,
        [clientId, pageSize, (page - 1) * pageSize],
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
  // Directory
  // ---------------------------------------------------------------------------
  async userDirectory(auth: AuthContext): Promise<UserRef[]> {
    return this.db.tenant(auth, async (q) => {
      const rows = await q.query<Row>(`SELECT id, display_name, email FROM users WHERE status = 'active' ORDER BY display_name`);
      return rows.map((r) => ref(r.id, r.display_name, r.email)!);
    });
  }
}
