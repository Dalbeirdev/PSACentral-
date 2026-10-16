import { describe, expect, it } from 'vitest';
import { loadMigrationFiles, migrate } from '../../src/database/migrator.js';
import { seed } from '../../src/database/seed.js';
import { asApp, ids, ownerQuery, testEnv } from './helpers.js';

const EXPECTED_TABLES = [
  'agent_certificates', 'audit_events', 'client_contacts', 'client_services', 'clients', 'command_signing_keys', 'deployment_health_events', 'deployment_heartbeats', 'deployment_package_downloads', 'deployment_packages',
  'deployment_report_latest', 'deployment_reports', 'deployment_tables', 'deployments', 'enrollment_tokens', 'health_policies', 'licenses', 'onboarding_drafts',
  'organization_sequences', 'organizations', 'permissions', 'pki_authorities', 'psa_instance_services', 'psa_instances', 'psa_providers', 'remote_commands', 'retention_policies', 'role_permissions', 'roles',
  'schema_migrations', 'service_categories', 'services', 'sessions', 'user_client_assignments', 'user_recovery_codes', 'user_roles', 'users',
];

describe('migrations', () => {
  it('created every expected table with row-level security on tenant tables', async () => {
    const rows = await ownerQuery<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual(EXPECTED_TABLES);
    const noRls = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    // Global catalogs, plus the platform PKI and the command signing key (no tenant column; private keys are encrypted).
    expect(noRls.sort()).toEqual(['command_signing_keys', 'permissions', 'pki_authorities', 'psa_providers', 'schema_migrations']);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const r = await migrate(testEnv().MIGRATION_DATABASE_URL!, () => undefined);
    expect(r.applied).toEqual([]);
    expect(r.alreadyApplied).toBe(loadMigrationFiles().length);
  });

  it('refuses to run when an applied migration was modified', async () => {
    const [m] = await ownerQuery<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE version = '0001'`);
    await ownerQuery(`UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = '0001'`);
    try {
      await expect(migrate(testEnv().MIGRATION_DATABASE_URL!, () => undefined)).rejects.toThrow(/checksum mismatch/);
    } finally {
      await ownerQuery(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0001'`, [m!.checksum]);
    }
  });

  it('syncs the permission catalog and the 8 system roles as reference data', async () => {
    const roles = await ownerQuery<{ key: string; n: number }>(
      `SELECT r.key, count(rp.*)::int AS n FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.is_system GROUP BY r.key ORDER BY r.key`,
    );
    expect(roles.map((r) => r.key)).toEqual(['auditor', 'ops_admin', 'read_only', 'security_admin', 'service_manager', 'super_admin', 'tech_admin', 'technician']);
    const total = await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM permissions');
    expect(roles.find((r) => r.key === 'super_admin')!.n).toBe(total[0]!.n);
    const providers = await ownerQuery<{ key: string }>('SELECT key FROM psa_providers ORDER BY sort_order');
    expect(providers.map((p) => p.key)).toEqual(['autotask', 'connectwise', 'halopsa', 'kaseya_bms', 'freshservice', 'servicenow', 'custom_rest']);
  });

  it('seeding refuses to run outside development/test', async () => {
    const prev = process.env.APP_ENV;
    process.env.APP_ENV = 'production';
    try {
      await expect(seed(testEnv().MIGRATION_DATABASE_URL!, { password: 'x', log: () => undefined })).rejects.toThrow(/Refusing to seed/);
    } finally {
      process.env.APP_ENV = prev;
    }
  });
});

describe('least-privilege application role', () => {
  it('psacc_app cannot bypass RLS and is not a superuser', async () => {
    const [r] = await ownerQuery<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'psacc_app'`,
    );
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
  });

  it('cannot change the schema', async () => {
    await asApp(null, async (c) => {
      await expect(c.query('CREATE TABLE pwned (id int)')).rejects.toThrow(/permission denied/);
    });
    await asApp(null, async (c) => {
      await expect(c.query('ALTER TABLE clients DISABLE ROW LEVEL SECURITY')).rejects.toThrow(/must be owner/);
    });
    await asApp(null, async (c) => {
      await expect(c.query('SET ROLE psacc_owner')).rejects.toThrow(/permission denied/);
    });
  });

  it('audit events and health events are append-only for the application', async () => {
    const { orgA } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(c.query(`UPDATE audit_events SET action = 'tampered.event'`)).rejects.toThrow(/permission denied/);
    });
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(c.query('DELETE FROM audit_events')).rejects.toThrow(/permission denied/);
    });
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(c.query('DELETE FROM deployment_health_events')).rejects.toThrow(/permission denied/);
    });
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(c.query('TRUNCATE audit_events')).rejects.toThrow(/permission denied/);
    });
  });

  it('cannot read global identity data through the auth functions beyond what login needs', async () => {
    await asApp(null, async (c) => {
      const r = await c.query(`SELECT * FROM auth_lookup_user('avery.admin@psacc.test')`);
      expect(Object.keys(r.rows[0]).sort()).toEqual(['auth_provider', 'locked_until', 'org_status', 'organization_id', 'password_hash', 'status', 'user_id']);
      expect((await c.query(`SELECT * FROM auth_resolve_session(decode(repeat('00', 32), 'hex'))`)).rowCount).toBe(0);
    });
  });
});

describe('data integrity constraints', () => {
  async function expectViolation(sql: string, params: unknown[], pattern: RegExp) {
    const { orgA } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(c.query(sql, params)).rejects.toThrow(pattern);
    });
  }

  it('client references are unique per organization, case-insensitively', async () => {
    const { orgA } = await ids();
    await expectViolation(
      `INSERT INTO clients (organization_id, code, client_reference, legal_name, display_name) VALUES ($1, 'CL-99998', 'acct-1040', 'Dup Ref Inc', 'Dup Ref')`,
      [orgA],
      /clients_org_reference_key/,
    );
  });

  it('a deployment cannot report health before it has enrolled', async () => {
    const { orgA } = await ids();
    const [client] = await ownerQuery<{ id: string }>(`SELECT id FROM clients WHERE organization_id = $1 LIMIT 1`, [orgA]).catch(() => [] as { id: string }[]);
    const target = client?.id ?? (await asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query('SELECT id FROM clients LIMIT 1')).rows[0].id as string));
    await expectViolation(
      `INSERT INTO deployments (organization_id, client_id, code, target_environment, lifecycle_state, health_state, package_generated_at)
       VALUES ($1, $2, 'DEP-99999', 'linux_docker', 'package_downloaded', 'healthy', now())`,
      [orgA, target],
      /deployments_health_requires_enrollment/,
    );
  });

  it('PSA connectivity cannot be marked verified without a recorded successful test', async () => {
    await expectViolation(`UPDATE psa_instances SET connection_status = 'succeeded'`, [], /psa_instances_verified_requires_test/);
  });

  it('contract end date cannot precede the start date', async () => {
    await expectViolation(`UPDATE clients SET contract_start_date = '2026-05-01', contract_end_date = '2026-01-01'`, [], /clients_contract_dates/);
  });

  it('a deployment can only bind a PSA instance belonging to the same client', async () => {
    const { orgA } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      const pair = await c.query(
        `SELECT d.id AS dep, i.id AS psa FROM deployments d JOIN psa_instances i ON i.client_id <> d.client_id LIMIT 1`,
      );
      await expect(c.query('UPDATE deployments SET psa_instance_id = $2 WHERE id = $1', [pair.rows[0].dep, pair.rows[0].psa])).rejects.toThrow(
        /deployments_psa_instance_fk/,
      );
    });
  });
});
