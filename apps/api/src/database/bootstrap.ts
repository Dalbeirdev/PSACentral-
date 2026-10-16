import { passwordPolicyViolations } from '@psacc/contracts';
import pg from 'pg';
import { hashPassword } from '../modules/auth/password.js';
import { ensureDefaultServiceCatalog } from './reference-data.js';

export interface BootstrapOptions {
  orgName: string;
  orgSlug: string;
  adminEmail: string;
  adminName: string;
  password: string;
  timezone?: string;
}

/**
 * Creates the first organization and its Super Administrator — the only way to get a user into an
 * environment where synthetic seeding is refused. Idempotent: an existing organization slug is left
 * untouched. The password is never logged; it must be changed after the first sign-in.
 */
export async function bootstrap(ownerUrl: string, o: BootstrapOptions): Promise<{ status: 'created' | 'exists'; organizationId: string }> {
  const email = o.adminEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid e-mail address.');
  const violations = passwordPolicyViolations(o.password, email);
  if (violations.length) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy: ${violations.join('; ')}`);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(o.orgSlug)) throw new Error('BOOTSTRAP_ORG_SLUG must be lowercase letters, digits and dashes.');
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'psacc-bootstrap' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM organizations WHERE slug = $1', [o.orgSlug]);
    if (existing.rows[0]) {
      await client.query('ROLLBACK');
      return { status: 'exists', organizationId: existing.rows[0].id as string };
    }
    const org = await client.query('INSERT INTO organizations (slug, name, is_synthetic) VALUES ($1, $2, false) RETURNING id', [o.orgSlug, o.orgName.trim()]);
    const orgId = org.rows[0].id as string;
    await ensureDefaultServiceCatalog(client, orgId); // also sets the tenant context for the rows below
    const hash = await hashPassword(o.password);
    const user = await client.query(
      `INSERT INTO users (organization_id, email, display_name, password_hash, password_changed_at, timezone, is_synthetic)
       VALUES ($1, $2, $3, $4, now(), $5, false) RETURNING id`,
      [orgId, email, o.adminName.trim() || 'Platform Administrator', hash, o.timezone ?? 'UTC'],
    );
    await client.query(
      `INSERT INTO user_roles (organization_id, user_id, role_id) SELECT $1, $2, id FROM roles WHERE key = 'super_admin' AND organization_id IS NULL`,
      [orgId, user.rows[0].id],
    );
    await client.query(
      `INSERT INTO audit_events (organization_id, action, outcome, actor_type, actor_display, target_type, target_id, target_display, metadata)
       VALUES ($1, 'organization.bootstrapped', 'success', 'system', 'bootstrap', 'user', $2, $3, $4)`,
      [orgId, user.rows[0].id, email, JSON.stringify({ role: 'super_admin', slug: o.orgSlug })],
    );
    await client.query('COMMIT');
    return { status: 'created', organizationId: orgId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
