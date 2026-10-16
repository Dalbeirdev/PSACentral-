import { describe, expect, it } from 'vitest';
import {
  createUserSchema,
  listQuerySchema,
  loginRequestSchema,
  passwordPolicyViolations,
  PERMISSION_KEYS,
  SYSTEM_ROLES,
  updateUserSchema,
} from './index.js';

describe('permission catalog', () => {
  it('every system role only references known permissions', () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      for (const p of role.permissions) expect(PERMISSION_KEYS).toContain(p);
    }
  });

  it('super_admin holds every permission; read_only holds no write/manage permission', () => {
    expect([...SYSTEM_ROLES.super_admin.permissions].sort()).toEqual([...PERMISSION_KEYS].sort());
    const writes = SYSTEM_ROLES.read_only.permissions.filter((p) => /\.(write|manage|generate|issue)$/.test(p));
    expect(writes).toEqual([]);
  });

  it('read_only and auditor cannot change deployments', () => {
    for (const key of ['read_only', 'auditor'] as const) {
      expect(SYSTEM_ROLES[key].permissions).not.toContain('deployments.write');
      expect(SYSTEM_ROLES[key].permissions).not.toContain('deployments.package.generate');
      expect(SYSTEM_ROLES[key].permissions).not.toContain('deployments.commands.issue');
    }
  });

  it('technician is limited to assigned clients; administrators see all clients', () => {
    expect(SYSTEM_ROLES.technician.scope).toBe('assigned_clients');
    expect(SYSTEM_ROLES.super_admin.scope).toBe('all_clients');
    expect(SYSTEM_ROLES.ops_admin.scope).toBe('all_clients');
  });

  it('role permission lists contain no duplicates', () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      expect(new Set(role.permissions).size).toBe(role.permissions.length);
    }
  });
});

describe('validation schemas', () => {
  it('normalizes login email and rejects unknown keys', () => {
    expect(loginRequestSchema.parse({ email: '  Admin@Example.COM ', password: 'x' }).email).toBe('admin@example.com');
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x', isAdmin: true }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
  });

  it('password policy flags short, repeated and email-derived passwords', () => {
    expect(passwordPolicyViolations('short')).not.toHaveLength(0);
    expect(passwordPolicyViolations('aaaaaaaaaaaaaaa')).not.toHaveLength(0);
    expect(passwordPolicyViolations('avery-vance-2026!!', 'avery@example.com')).not.toHaveLength(0);
    expect(passwordPolicyViolations('correct-horse-battery-9', 'avery@example.com')).toHaveLength(0);
  });

  it('list query enforces bounds and sort syntax', () => {
    expect(listQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(listQuerySchema.safeParse({ pageSize: '1000' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ sort: 'name;drop table' }).success).toBe(false);
    expect(listQuerySchema.parse({ sort: 'occurredAt:desc', page: '2' })).toMatchObject({ page: 2, sort: 'occurredAt:desc' });
  });

  it('user create requires roles and rejects duplicates', () => {
    expect(createUserSchema.safeParse({ email: 'a@b.co', displayName: 'A B', roleKeys: [] }).success).toBe(false);
    expect(createUserSchema.safeParse({ email: 'a@b.co', displayName: 'A B', roleKeys: ['auditor', 'auditor'] }).success).toBe(false);
    expect(createUserSchema.safeParse({ email: 'a@b.co', displayName: 'A B', roleKeys: ['auditor'] }).success).toBe(true);
    expect(updateUserSchema.safeParse({}).success).toBe(false);
  });
});
