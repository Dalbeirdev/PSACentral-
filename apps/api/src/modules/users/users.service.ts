import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateUserRequest,
  type CreateUserResponse,
  type Paged,
  type PermissionKey,
  passwordPolicyViolations,
  type RoleSummary,
  type UpdateUserRequest,
  type UserDetail,
  type UserSummary,
} from '@psacc/contracts';
import type { z } from 'zod';
import type { userListQuerySchema } from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { AppError } from '../../common/problem.filter.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService, escapeLike } from '../audit/audit.service.js';
import { isValidTimeZone } from '../auth/auth.service.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { SessionService } from '../auth/session.service.js';

type UserListQuery = z.infer<typeof userListQuerySchema>;

const PRIVILEGED_ROLES = new Set(['super_admin']);
const SORTABLE: Record<string, string> = {
  displayName: 'u.display_name',
  email: 'u.email',
  lastLoginAt: 'u.last_login_at',
  createdAt: 'u.created_at',
};

interface UserRowFull {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'disabled';
  locked_until: Date | null;
  mfa_enabled: boolean;
  auth_provider: 'local' | 'oidc';
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  timezone: string;
  is_synthetic: boolean;
  roles: { key: string; name: string; scope: string }[];
}

const USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.status, u.locked_until, u.mfa_enabled, u.auth_provider,
         u.last_login_at, u.created_at, u.updated_at, u.timezone, u.is_synthetic,
         coalesce((SELECT json_agg(json_build_object('key', r.key, 'name', r.name, 'scope', r.scope) ORDER BY r.name)
                   FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '[]') AS roles
  FROM users u`;

function toSummary(r: UserRowFull): UserSummary {
  const locked = r.locked_until !== null && r.locked_until.getTime() > Date.now();
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    status: r.status === 'active' && locked ? 'locked' : r.status,
    mfaEnabled: r.mfa_enabled,
    authProvider: r.auth_provider,
    roles: r.roles.map(({ key, name }) => ({ key, name })),
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    isSynthetic: r.is_synthetic,
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async list(auth: AuthContext, query: UserListQuery): Promise<Paged<UserSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.q) {
      params.push(`%${escapeLike(query.q)}%`);
      where.push(`(u.email ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`u.status = $${params.length}`);
    }
    if (query.role) {
      params.push(query.role);
      where.push(`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key = $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [field, dir] = (query.sort ?? 'displayName:asc').split(':') as [string, string];
    const order = `${SORTABLE[field] ?? 'u.display_name'} ${dir === 'desc' ? 'DESC NULLS LAST' : 'ASC NULLS LAST'}, u.id`;

    return this.db.tenant(auth, async (q) => {
      const total = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM users u ${whereSql}`, params);
      const rows = await q.query<UserRowFull>(
        `${USER_SELECT} ${whereSql} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      );
      return { items: rows.map(toSummary), page: query.page, pageSize: query.pageSize, total: total.n };
    });
  }

  private async detail(q: Queryable, id: string): Promise<UserDetail | null> {
    const row = await q.maybeOne<UserRowFull>(`${USER_SELECT} WHERE u.id = $1`, [id]);
    if (!row) return null;
    const assigned = await q.query<{ id: string; code: string; display_name: string }>(
      `SELECT c.id, c.code, c.display_name FROM user_client_assignments a
       JOIN clients c ON c.id = a.client_id WHERE a.user_id = $1 ORDER BY c.display_name`,
      [id],
    );
    return {
      ...toSummary(row),
      timezone: row.timezone,
      clientScope: row.roles.some((r) => r.scope === 'all_clients') ? 'all_clients' : 'assigned_clients',
      assignedClients: assigned.map((c) => ({ id: c.id, code: c.code, displayName: c.display_name })),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async get(auth: AuthContext, id: string): Promise<UserDetail> {
    const user = await this.db.tenant(auth, (q) => this.detail(q, id));
    if (!user) throw new AppError(404, 'not-found', 'User not found.');
    return user;
  }

  private async resolveRoles(q: Queryable, auth: AuthContext, keys: string[]) {
    const roles = await q.query<{ id: string; key: string }>('SELECT id, key FROM roles WHERE key = ANY($1::text[])', [keys]);
    const unknown = keys.filter((k) => !roles.some((r) => r.key === k));
    if (unknown.length) throw new AppError(422, 'unknown-role', `Unknown role(s): ${unknown.join(', ')}.`);
    if (keys.some((k) => PRIVILEGED_ROLES.has(k)) && !auth.permissions.has('roles.manage' as PermissionKey)) {
      throw new AppError(403, 'privileged-role', 'Only users who can manage roles may grant the Super Administrator role.');
    }
    return roles;
  }

  async create(auth: AuthContext, dto: CreateUserRequest, meta: RequestMeta): Promise<CreateUserResponse> {
    if (!isValidTimeZone(dto.timezone)) throw new AppError(422, 'invalid-timezone', 'Choose a valid IANA time zone.');
    const temporaryPassword = dto.initialPassword ? undefined : generateTemporaryPassword();
    const password = dto.initialPassword ?? temporaryPassword!;
    const violations = passwordPolicyViolations(password, dto.email);
    if (violations.length) throw new AppError(422, 'password-policy', violations.join(' '));
    const hash = await hashPassword(password);

    const user = await this.db.tenant(auth, async (q) => {
      const roles = await this.resolveRoles(q, auth, dto.roleKeys);
      let row: { id: string };
      try {
        row = await q.one<{ id: string }>(
          `INSERT INTO users (organization_id, email, display_name, password_hash, password_changed_at, must_change_password, timezone, created_by)
           VALUES ($1, $2, $3, $4, now(), true, $5, $6) RETURNING id`,
          [auth.orgId, dto.email, dto.displayName, hash, dto.timezone, auth.userId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new AppError(409, 'email-taken', 'A user with this email address already exists.');
        throw err;
      }
      for (const r of roles) {
        await q.query('INSERT INTO user_roles (organization_id, user_id, role_id, granted_by) VALUES ($1, $2, $3, $4)', [
          auth.orgId,
          row.id,
          r.id,
          auth.userId,
        ]);
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'user.created', outcome: 'success', actorUserId: auth.userId,
        actorDisplay: await this.actorEmail(q, auth), meta, targetType: 'user', targetId: row.id, targetDisplay: dto.email,
        metadata: { roles: dto.roleKeys, passwordSource: temporaryPassword ? 'generated_temporary' : 'admin_supplied', mustChangePassword: true },
      });
      return (await this.detail(q, row.id))!;
    });
    return { user, ...(temporaryPassword ? { temporaryPassword } : {}) };
  }

  async update(auth: AuthContext, id: string, dto: UpdateUserRequest, meta: RequestMeta): Promise<UserDetail> {
    if (id === auth.userId && (dto.roleKeys || dto.status)) {
      throw new AppError(403, 'self-modification', 'You cannot change your own roles or status. Ask another administrator.');
    }
    return this.db.tenant(auth, async (q) => {
      const before = await this.detail(q, id);
      if (!before) throw new AppError(404, 'not-found', 'User not found.');
      const targetPrivileged = before.roles.some((r) => PRIVILEGED_ROLES.has(r.key));
      if (targetPrivileged && !auth.permissions.has('roles.manage')) {
        throw new AppError(403, 'privileged-target', 'Only users who can manage roles may modify a Super Administrator.');
      }

      const changes: Record<string, unknown> = {};
      if (dto.displayName !== undefined && dto.displayName !== before.displayName) {
        await q.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, dto.displayName]);
        changes.displayName = { from: before.displayName, to: dto.displayName };
      }
      const currentStatus = before.status === 'locked' ? 'active' : before.status;
      if (dto.status !== undefined && dto.status !== currentStatus) {
        if (dto.status === 'disabled' && targetPrivileged) await this.assertAnotherSuperAdmin(q, id);
        await q.query('UPDATE users SET status = $2 WHERE id = $1', [id, dto.status]);
        if (dto.status === 'disabled') changes.sessionsRevoked = await this.sessions.revokeAllForUser(q, id, 'user_disabled');
        changes.status = { from: currentStatus, to: dto.status };
      }
      if (dto.roleKeys) {
        const beforeKeys = before.roles.map((r) => r.key).sort();
        const afterKeys = [...dto.roleKeys].sort();
        if (beforeKeys.join() !== afterKeys.join()) {
          const roles = await this.resolveRoles(q, auth, dto.roleKeys);
          if (targetPrivileged && !afterKeys.some((k) => PRIVILEGED_ROLES.has(k))) await this.assertAnotherSuperAdmin(q, id);
          await q.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
          for (const r of roles) {
            await q.query('INSERT INTO user_roles (organization_id, user_id, role_id, granted_by) VALUES ($1, $2, $3, $4)', [
              auth.orgId, id, r.id, auth.userId,
            ]);
          }
          // Permissions are re-read on every request, but revoke sessions so the change is unambiguous.
          changes.sessionsRevoked = await this.sessions.revokeAllForUser(q, id, 'roles_changed');
          changes.roles = { from: beforeKeys, to: afterKeys };
        }
      }
      if (Object.keys(changes).length) {
        await this.audit.write(q, {
          orgId: auth.orgId, action: changes.roles ? 'user.roles.changed' : 'user.updated', outcome: 'success',
          actorUserId: auth.userId, actorDisplay: await this.actorEmail(q, auth), meta, targetType: 'user', targetId: id,
          targetDisplay: before.email, metadata: { changes },
        });
      }
      return (await this.detail(q, id))!;
    });
  }

  /** Replaces the clients a user may access when none of their roles grants all-clients scope. */
  async setClientAssignments(auth: AuthContext, id: string, clientIds: string[], meta: RequestMeta): Promise<UserDetail> {
    return this.db.tenant(auth, async (q) => {
      const user = await this.detail(q, id);
      if (!user) throw new AppError(404, 'not-found', 'User not found.');
      if (clientIds.length) {
        const found = await q.query<{ id: string }>('SELECT id FROM clients WHERE id = ANY($1::uuid[])', [clientIds]);
        if (found.length !== clientIds.length) throw new AppError(422, 'unknown-client', 'One or more clients do not exist or are not accessible to you.');
      }
      const before = user.assignedClients.map((c) => c.id);
      const added = clientIds.filter((c) => !before.includes(c));
      const removed = before.filter((c) => !clientIds.includes(c));
      if (!added.length && !removed.length) return user;
      if (removed.length) await q.query('DELETE FROM user_client_assignments WHERE user_id = $1 AND client_id = ANY($2::uuid[])', [id, removed]);
      for (const c of added) {
        await q.query('INSERT INTO user_client_assignments (organization_id, user_id, client_id, assigned_by) VALUES ($1, $2, $3, $4)', [auth.orgId, id, c, auth.userId]);
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'user.client_assignments.changed', outcome: 'success', actorUserId: auth.userId,
        actorDisplay: await this.actorEmail(q, auth), meta, targetType: 'user', targetId: id, targetDisplay: user.email,
        metadata: { added, removed, effective: user.clientScope === 'all_clients' ? 'not applied (user has an all-clients role)' : 'applied' },
      });
      return (await this.detail(q, id))!;
    });
  }

  private async assertAnotherSuperAdmin(q: Queryable, exceptUserId: string) {
    const r = await q.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE r.key = 'super_admin' AND u.status = 'active' AND u.id <> $1`,
      [exceptUserId],
    );
    if (r.n === 0) throw new AppError(409, 'last-super-admin', 'This is the last active Super Administrator.');
  }

  private async actorEmail(q: Queryable, auth: AuthContext): Promise<string> {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  async roles(auth: AuthContext): Promise<RoleSummary[]> {
    return this.db.tenant(auth, async (q) => {
      const rows = await q.query<{
        id: string; key: string; name: string; description: string; is_system: boolean; scope: 'all_clients' | 'assigned_clients';
        perms: PermissionKey[]; user_count: number;
      }>(
        `SELECT r.id, r.key, r.name, r.description, r.is_system, r.scope,
                coalesce((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permissions rp WHERE rp.role_id = r.id), '{}') AS perms,
                (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count
         FROM roles r
         ORDER BY r.is_system DESC, array_position(ARRAY['super_admin','ops_admin','tech_admin','technician','service_manager','security_admin','auditor','read_only'], r.key), r.name`,
      );
      return rows.map((r) => ({
        id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.is_system, scope: r.scope,
        permissions: r.perms, userCount: r.user_count,
      }));
    });
  }
}
