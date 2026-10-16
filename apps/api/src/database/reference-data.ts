import { DEFAULT_SERVICE_CATEGORIES, DEFAULT_SERVICES, PERMISSIONS, PSA_PROVIDER_CATALOG, SYSTEM_ROLES } from '@psacc/contracts';
import type pg from 'pg';

/**
 * Gives an organization the default service catalog. Only missing keys are inserted; existing
 * rows (possibly edited by administrators) are never overwritten. Must run inside a transaction.
 */
export async function ensureDefaultServiceCatalog(client: pg.Client | pg.PoolClient, orgId: string): Promise<void> {
  await client.query(`SELECT set_config('app.org_id', $1, true), set_config('app.scope_all', 'on', true)`, [orgId]);
  for (const c of DEFAULT_SERVICE_CATEGORIES) {
    await client.query(
      `INSERT INTO service_categories (organization_id, key, name, sort_order) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, key) DO NOTHING`,
      [orgId, c.key, c.name, c.sortOrder],
    );
  }
  for (const s of DEFAULT_SERVICES) {
    await client.query(
      `INSERT INTO services (organization_id, category_id, key, name, description, is_default, requires_psa, integration_dependencies, config_requirements, sort_order)
       SELECT $1, sc.id, $3, $4, $5, $6, $7, $8, $9, $10 FROM service_categories sc WHERE sc.organization_id = $1 AND sc.key = $2
       ON CONFLICT (organization_id, key) DO NOTHING`,
      [orgId, s.category, s.key, s.name, s.description, s.isDefault, s.requiresPsa, s.integrationDependencies, JSON.stringify(s.configRequirements ?? []), s.sortOrder],
    );
  }
}

/**
 * Idempotently syncs code-defined reference data (runs as schema owner after migrations):
 * permission catalog, immutable system roles + their permissions, PSA provider catalog.
 * Custom (organization) roles are never touched.
 */
export async function syncReferenceData(client: pg.Client | pg.PoolClient): Promise<void> {
  const permKeys = Object.keys(PERMISSIONS);
  for (const [key, def] of Object.entries(PERMISSIONS)) {
    await client.query(
      `INSERT INTO permissions (key, category, description) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category, description = EXCLUDED.description`,
      [key, def.category, def.description],
    );
  }
  await client.query('DELETE FROM permissions WHERE NOT (key = ANY($1::text[]))', [permKeys]);

  for (const role of Object.values(SYSTEM_ROLES)) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO roles (organization_id, key, name, description, scope, is_system)
       VALUES (NULL, $1, $2, $3, $4, true)
       ON CONFLICT (organization_id, key) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description, scope = EXCLUDED.scope
       RETURNING id`,
      [role.key, role.name, role.description, role.scope],
    );
    const roleId = rows[0]!.id;
    await client.query('DELETE FROM role_permissions WHERE role_id = $1 AND NOT (permission_key = ANY($2::text[]))', [
      roleId,
      role.permissions,
    ]);
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_key)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [roleId, role.permissions],
    );
  }

  const orgs = await client.query<{ id: string }>('SELECT id FROM organizations');
  for (const org of orgs.rows) await ensureDefaultServiceCatalog(client, org.id);

  for (const p of PSA_PROVIDER_CATALOG) {
    await client.query(
      `INSERT INTO psa_providers (key, name, vendor, auth_methods, adapter_status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, vendor = EXCLUDED.vendor,
         auth_methods = EXCLUDED.auth_methods, adapter_status = EXCLUDED.adapter_status, sort_order = EXCLUDED.sort_order`,
      [p.key, p.name, p.vendor, p.authMethods, p.adapterStatus, p.sortOrder],
    );
  }
}
