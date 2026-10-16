import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL, asApp, ids, orgAClientCount, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await app.close();
});

describe('organization isolation through the API', () => {
  it('organization A cannot see organization B data (search, dashboard, users, audit)', async () => {
    const a = await signedIn(app, EMAIL.admin);
    const { user } = await ids();
    expect((await a.get('/search?q=Zephyr')).body.results).toEqual([]);
    expect((await a.get('/dashboard/summary')).body.kpis.totalClients).toBe(await orgAClientCount());
    expect((await a.get(`/users/${user(EMAIL.orgB)}`)).status).toBe(404);
    expect((await a.get('/users?q=isolation')).body.items).toEqual([]);
    const audit = await a.get('/audit-events?q=org_b&pageSize=100');
    expect(audit.body.items).toEqual([]);
    expect((await a.get('/dashboard/summary')).body.versionDistribution.map((v: { version: string }) => v.version)).not.toContain('9.9.9');
  });

  it('organization B sees only its own single client', async () => {
    const b = await signedIn(app, EMAIL.orgB);
    const { user } = await ids();
    const dash = (await b.get('/dashboard/summary')).body;
    expect(dash.kpis.totalClients).toBe(1);
    expect(dash.kpis.criticalAlerts).toBe(1);
    expect((await b.get('/search?q=Bluepeak')).body.results).toEqual([]);
    expect((await b.get('/search?q=Zephyr')).body.results.length).toBeGreaterThan(0);
    expect((await b.get(`/users/${user(EMAIL.admin)}`)).status).toBe(404);
    const users = (await b.get('/users')).body;
    expect(users.items.map((u: { email: string }) => u.email)).toEqual([EMAIL.orgB]);
    // Same client reference "ACCT-1040" exists in both orgs: uniqueness is per organization.
    expect((await b.get('/search?q=ACCT-1040')).body.results).toHaveLength(1);
  });
});

describe('organization isolation enforced by PostgreSQL row-level security', () => {
  const TABLES = ['clients', 'psa_instances', 'deployments', 'deployment_health_events', 'users', 'sessions', 'audit_events', 'user_roles', 'organizations'];

  it('with no tenant context, the application role sees zero rows in every tenant table (fail closed)', async () => {
    await asApp(null, async (c) => {
      for (const t of TABLES) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect({ t, n: r.rows[0].n }).toEqual({ t, n: 0 });
      }
    });
  });

  it('an unfiltered query under org A context returns only org A rows', async () => {
    const { orgA, orgB } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      for (const t of ['clients', 'psa_instances', 'deployments', 'users', 'audit_events']) {
        const r = await c.query(`SELECT count(*) FILTER (WHERE organization_id = $1)::int AS foreign_rows, count(*)::int AS total FROM ${t}`, [orgB]);
        expect({ t, foreign: r.rows[0].foreign_rows }).toEqual({ t, foreign: 0 });
        expect(r.rows[0].total).toBeGreaterThan(0);
      }
    });
  });

  it('cannot write into, update or delete another organization’s rows', async () => {
    const { orgA, orgB } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(
        c.query(`INSERT INTO clients (organization_id, code, client_reference, legal_name, display_name) VALUES ($1, 'CL-99999', 'X', 'Cross Tenant', 'Cross Tenant')`, [orgB]),
      ).rejects.toThrow(/row-level security/);
    });
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      const upd = await c.query(`UPDATE clients SET display_name = 'pwned' WHERE organization_id = $1`, [orgB]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query(`DELETE FROM deployments WHERE organization_id = $1`, [orgB]);
      expect(del.rowCount).toBe(0);
    });
  });

  it('technician scope is enforced in the database, not only in the API', async () => {
    const { orgA, user } = await ids();
    await asApp({ orgId: orgA, userId: user(EMAIL.technician), scopeAll: false }, async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM clients')).rows[0].n).toBe(4);
      const deps = await c.query(
        `SELECT count(*)::int AS n FROM deployments d WHERE NOT EXISTS (SELECT 1 FROM user_client_assignments a WHERE a.client_id = d.client_id AND a.user_id = $1)`,
        [user(EMAIL.technician)],
      );
      expect(deps.rows[0].n).toBe(0);
    });
    // A user with no assignments and no all-clients role sees nothing.
    await asApp({ orgId: orgA, userId: user(EMAIL.viewer), scopeAll: false }, async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM clients')).rows[0].n).toBe(0);
    });
  });
});
