import pg from 'pg';
import { migrate } from '../../src/database/migrator.js';
import { ensureDefaultServiceCatalog } from '../../src/database/reference-data.js';
import { seed } from '../../src/database/seed.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { EMAIL, testEnv } from './helpers.js';

/**
 * Deployment codes in the test database start at DEP-90501. The Docker suites install real packages whose
 * Compose project (`psacc-dep-nnnnn`) and local admin port (18000 + nnnnn mod 1000) derive from the code; a
 * developer workstation may run a real appliance from the dev database (small codes, e.g. DEP-00030), and a
 * colliding project name would let the suites' cleanup remove it. Test codes stay far away from real ones.
 */
async function offsetDeploymentCodes(connectionString: string): Promise<void> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    // The sequence table is tenant-scoped (FORCE RLS), so each organization is addressed in its own context.
    const orgs = await c.query<{ id: string }>(`SELECT id FROM organizations`);
    for (const { id } of orgs.rows) {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true)`, [id]);
      await c.query(
        `INSERT INTO organization_sequences (organization_id, name, last_value) VALUES ($1, 'deployment', 90500)
         ON CONFLICT (organization_id, name) DO UPDATE SET last_value = GREATEST(organization_sequences.last_value, 90500)`,
        [id],
      );
      await c.query('COMMIT');
    }
  } finally {
    await c.end();
  }
}

/**
 * Rebuilds the isolated psacc_test database from scratch for every run:
 * drop schema → run all migrations → synthetic seed (org A) → isolation org B.
 */
export default async function setup() {
  const env = testEnv();
  if (!/\/psacc_test$/.test(env.MIGRATION_DATABASE_URL!)) throw new Error('Refusing to reset a database that is not psacc_test');
  const owner = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public AUTHORIZATION psacc_owner;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO psacc_app_rw;`);
  } finally {
    await owner.end();
  }

  process.env.APP_ENV = 'test';
  await migrate(env.MIGRATION_DATABASE_URL!, () => undefined);
  await seed(env.MIGRATION_DATABASE_URL!, { password: env.SEED_DEFAULT_PASSWORD!, log: () => undefined });
  await offsetDeploymentCodes(env.MIGRATION_DATABASE_URL!);

  // Organization B: a separate tenant with its own admin, client, PSA instance and deployment.
  const c = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const org = await c.query(`INSERT INTO organizations (slug, name, is_synthetic) VALUES ('isolation-org-b', 'Isolation Test Org B', true) RETURNING id`);
    const orgId = org.rows[0].id as string;
    await ensureDefaultServiceCatalog(c, orgId); // sets the tenant context too
    const user = await c.query(
      `INSERT INTO users (organization_id, email, display_name, password_hash, timezone, is_synthetic)
       VALUES ($1, $2, 'Blake Isolation', $3, 'UTC', true) RETURNING id`,
      [orgId, EMAIL.orgB, await hashPassword(env.SEED_DEFAULT_PASSWORD!)],
    );
    await c.query(`INSERT INTO user_roles (organization_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'super_admin' AND organization_id IS NULL`, [orgId, user.rows[0].id]);
    const client = await c.query(
      `INSERT INTO clients (organization_id, code, client_reference, legal_name, display_name, status, is_synthetic)
       VALUES ($1, next_org_code('client', 'CL'), 'ACCT-1040', 'Zephyr Secret Holdings Ltd', 'Zephyr Secret Holdings', 'active', true) RETURNING id`,
      [orgId],
    );
    const psa = await c.query(
      `INSERT INTO psa_instances (organization_id, client_id, code, provider_key, display_name, is_synthetic)
       VALUES ($1, $2, next_org_code('psa_instance', 'PSA'), 'connectwise', 'Zephyr ConnectWise', true) RETURNING id`,
      [orgId, client.rows[0].id],
    );
    await c.query(
      `INSERT INTO deployments (organization_id, client_id, psa_instance_id, code, target_environment, lifecycle_state, health_state,
         image_version, package_generated_at, enrolled_at, verified_at, is_synthetic)
       VALUES ($1, $2, $3, next_org_code('deployment', 'DEP'), 'linux_docker', 'verified', 'critical', '9.9.9', now(), now(), now(), true)`,
      [orgId, client.rows[0].id, psa.rows[0].id],
    );
    await c.query(`INSERT INTO audit_events (organization_id, actor_type, actor_display, action, outcome) VALUES ($1, 'system', 'setup', 'system.org_b.secret_event', 'success')`, [orgId]);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
}
