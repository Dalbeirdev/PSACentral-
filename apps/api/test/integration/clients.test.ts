import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL, asApp, ids, orgAClientCount, signedIn, startApp, testEnv } from './helpers.js';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await app.close();
});

async function clientId(code: string): Promise<string> {
  const { orgA } = await ids();
  return asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query('SELECT id FROM clients WHERE code = $1', [code])).rows[0].id as string);
}

function editPayload(detail: Record<string, any>, overrides: { company?: object; management?: object; status?: string; serviceStatus?: string } = {}) {
  return {
    version: detail.version,
    company: {
      legalName: detail.legalName, displayName: detail.displayName, clientReference: detail.clientReference,
      businessType: detail.businessType, countryCode: detail.countryCode, stateRegion: detail.stateRegion ?? '', city: detail.city ?? '',
      timezone: detail.timezone, website: detail.website ?? '', ...overrides.company,
    },
    management: {
      accountManagerUserId: detail.accountManager?.id ?? '', technicalOwnerUserId: detail.technicalOwner?.id ?? '',
      onboardingDate: detail.onboardingDate ?? '', contractStartDate: detail.contractStartDate ?? '', contractEndDate: detail.contractEndDate ?? '',
      internalNotes: detail.internalNotes ?? '', ...overrides.management,
    },
    status: overrides.status ?? detail.status,
    serviceStatus: overrides.serviceStatus ?? detail.serviceStatus,
  };
}

describe('client directory', () => {
  it('paginates, sorts and counts on the server', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const p1 = await c.get('/clients?pageSize=5&page=1&sort=code:asc');
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(5);
    expect(p1.body.total).toBe(await orgAClientCount());
    expect(p1.body.items.map((x: { code: string }) => x.code)).toEqual(['CL-00001', 'CL-00002', 'CL-00003', 'CL-00004', 'CL-00005']);
    const p2 = await c.get('/clients?pageSize=5&page=2&sort=code:asc');
    expect(p2.body.items[0].code).toBe('CL-00006');
    const desc = await c.get('/clients?pageSize=1&sort=displayName:desc');
    expect(desc.body.items[0].displayName).toBe('Wildflower Organic Foods');
  });

  it('searches name, legal name, reference, code and city; filters by status, country, PSA and health', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const names = async (qs: string) => (await c.get(`/clients?${qs}`)).body.items.map((x: { displayName: string }) => x.displayName);
    expect(await names('q=bluepeak')).toEqual(['Bluepeak Logistics']);
    expect(await names('q=ACCT-1040')).toEqual(['Bluepeak Logistics']);
    expect(await names('q=Edinburgh')).toEqual(['Alder & Vine Hospitality']);
    expect(await names('status=suspended')).toEqual(['Granite Ridge Construction']);
    expect((await names('country=GB')).sort()).toEqual(['Alder & Vine Hospitality', 'Saltmarsh Brewing Co.']);
    expect(await names('country=GB&provider=connectwise')).toEqual(['Alder & Vine Hospitality']);
    const critical = await c.get('/clients?health=critical');
    expect(critical.body.items.length).toBeGreaterThan(0);
    expect(critical.body.items.every((x: { health: { critical: number } }) => x.health.critical > 0)).toBe(true);
  });

  it('summaries include PSA providers, deployment health and account manager', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const meridian = (await c.get('/clients?q=Meridian')).body.items[0];
    expect(meridian.psaProviders.map((p: { key: string }) => p.key).sort()).toEqual(['connectwise', 'servicenow']);
    expect(meridian.deploymentCount).toBe(2);
    expect(Object.values(meridian.health).reduce((a: number, b) => a + (b as number), 0)).toBe(2);
    expect(meridian.accountManager.displayName).toBe('Jordan Ellis');
  });

  it('rejects invalid filters and sort fields', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    expect((await c.get('/clients?status=deleted')).status).toBe(400);
    expect((await c.get('/clients?country=gb')).status).toBe(400);
    expect((await c.get('/clients?sort=display_name;drop:asc')).status).toBe(400);
    expect((await c.get('/clients?pageSize=500')).status).toBe(400);
  });

  it('technicians only see assigned clients, including on direct access', async () => {
    const t = await signedIn(app, EMAIL.technician);
    const list = await t.get('/clients?pageSize=50');
    expect(list.body.total).toBe(4);
    const unassigned = await clientId('CL-00002');
    expect((await t.get(`/clients/${unassigned}`)).status).toBe(404);
    expect((await t.get(`/clients/${unassigned}/contacts`)).status).toBe(404);
    const assigned = await clientId('CL-00001');
    expect((await t.get(`/clients/${assigned}`)).status).toBe(200);
  });
});

describe('client detail & update', () => {
  it('returns management info, the primary contact, counts and a version token', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const d = (await c.get(`/clients/${await clientId('CL-00001')}`)).body;
    expect(d).toMatchObject({ code: 'CL-00001', displayName: 'Bluepeak Logistics', timezone: 'America/Chicago', countryCode: 'US' });
    expect(d.primaryContact.roles).toContain('primary');
    expect(d.counts).toMatchObject({ psaInstances: 1, deployments: 1 });
    expect(d.counts.contacts).toBeGreaterThanOrEqual(2);
    expect(d.assignedTechnicians.map((u: { displayName: string }) => u.displayName)).toEqual(['Riley Brooks']);
    expect(d.version).toMatch(/^\d+$/);
    expect(d.onboardingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('read-only users and technicians cannot edit', async () => {
    const id = await clientId('CL-00001');
    for (const email of [EMAIL.viewer, EMAIL.technician, EMAIL.auditor]) {
      const c = await signedIn(app, email);
      const d = (await c.get(`/clients/${id}`)).body;
      expect((await c.patch(`/clients/${id}`, editPayload(d))).status).toBe(403);
    }
  });

  it('updates fields, records a diff in the client activity, and returns a new version', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00003');
    const before = (await ops.get(`/clients/${id}`)).body;
    const r = await ops.patch(`/clients/${id}`, editPayload(before, { company: { city: 'Evanston' }, status: 'suspended', management: { internalNotes: 'Paused pending renewal.' } }));
    expect(r.status).toBe(200);
    expect(r.body.city).toBe('Evanston');
    expect(r.body.status).toBe('suspended');
    expect(r.body.version).not.toBe(before.version);
    const activity = (await ops.get(`/clients/${id}/activity`)).body.items;
    expect(activity[0].action).toBe('client.status.changed');
    expect(activity[0].metadata.changes.city).toEqual({ from: 'Chicago', to: 'Evanston' });
    expect(activity[0].metadata.changes.internal_notes).toEqual({ changed: true }); // note content is not copied into the audit trail
  });

  it('rejects a stale version (optimistic concurrency) with 409', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00004');
    const d = (await ops.get(`/clients/${id}`)).body;
    expect((await ops.patch(`/clients/${id}`, editPayload(d, { company: { city: 'Salem' } }))).status).toBe(200);
    const stale = await ops.patch(`/clients/${id}`, editPayload(d, { company: { city: 'Eugene' } }));
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('urn:psacc:problem:stale-version');
  });

  it('enforces unique client references per organization, case-insensitively', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00005');
    const d = (await ops.get(`/clients/${id}`)).body;
    const r = await ops.patch(`/clients/${id}`, editPayload(d, { company: { clientReference: 'acct-1040' } }));
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([{ path: 'company.clientReference', message: 'This reference is already used by CL-00001.' }]);
    const check = await ops.get('/clients/duplicate-check?reference=ACCT-1040');
    expect(check.body.referenceAvailable).toBe(false);
    expect((await ops.get('/clients/duplicate-check?reference=NEW-REF-999')).body.referenceAvailable).toBe(true);
    const similar = await ops.get('/clients/duplicate-check?legalName=Bluepeak%20Logistic');
    expect(similar.body.similar[0].code).toBe('CL-00001');
  });

  it.each([
    [{ company: { website: 'ftp://x.example' } }, 'company.website'],
    [{ company: { countryCode: 'XX' } }, 'company.countryCode'],
    [{ company: { timezone: 'Mars/Olympus' } }, 'company.timezone'],
    [{ company: { businessType: 'Space piracy' } }, 'company.businessType'],
    [{ management: { contractStartDate: '2026-06-01', contractEndDate: '2026-01-01' } }, 'management.contractEndDate'],
    [{ management: { accountManagerUserId: '00000000-0000-4000-8000-000000000000' } }, 'management.accountManagerUserId'],
  ])('validates %o → error at %s', async (overrides, path) => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00006');
    const d = (await ops.get(`/clients/${id}`)).body;
    const r = await ops.patch(`/clients/${id}`, editPayload(d, overrides));
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: { path: string }) => e.path)).toContain(path);
  });
});

describe('client contacts', () => {
  it('adds a contact; marking it primary demotes the previous primary', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00007');
    const before = (await ops.get(`/clients/${id}/contacts`)).body;
    const oldPrimary = before.find((c: { roles: string[] }) => c.roles.includes('primary'));
    const r = await ops.post(`/clients/${id}/contacts`, { fullName: 'New Primary', email: 'NEW.PRIMARY@alder.example', roles: ['primary', 'billing'], phone: '+44 20 7946 0000' });
    expect(r.status).toBe(201);
    expect(r.body.email).toBe('new.primary@alder.example');
    const after = (await ops.get(`/clients/${id}/contacts`)).body;
    expect(after.filter((c: { roles: string[] }) => c.roles.includes('primary'))).toHaveLength(1);
    expect(after[0].fullName).toBe('New Primary');
    expect(after.find((c: { id: string }) => c.id === oldPrimary.id).roles).not.toContain('primary');
  });

  it('protects the primary contact and rejects duplicate emails', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00008');
    const contacts = (await ops.get(`/clients/${id}/contacts`)).body;
    const primary = contacts.find((c: { roles: string[] }) => c.roles.includes('primary'));
    const other = contacts.find((c: { roles: string[] }) => !c.roles.includes('primary'));
    const demote = await ops.put(`/clients/${id}/contacts/${primary.id}`, { ...primary, roles: ['technical'], jobTitle: primary.jobTitle ?? undefined, id: undefined, isSynthetic: undefined, updatedAt: undefined, phone: primary.phone ?? undefined, mobile: primary.mobile ?? undefined, notes: primary.notes ?? undefined });
    expect(demote.status).toBe(400);
    expect(demote.body.errors[0].path).toBe('roles');
    expect((await ops.del(`/clients/${id}/contacts/${primary.id}`)).status).toBe(409);
    const dup = await ops.post(`/clients/${id}/contacts`, { fullName: 'Copy Cat', email: other.email, roles: ['other'] });
    expect(dup.status).toBe(409);
    expect(dup.body.type).toBe('urn:psacc:problem:duplicate-contact-email');
    expect((await ops.del(`/clients/${id}/contacts/${other.id}`)).status).toBe(204);
    const activity = (await ops.get(`/clients/${id}/activity`)).body.items.map((e: { action: string }) => e.action);
    expect(activity).toContain('client.contact.deleted');
  });

  it('validates contact input', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00009');
    const r = await ops.post(`/clients/${id}/contacts`, { fullName: 'X', email: 'nope', roles: [], phone: 'call me' });
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'fullName', 'phone', 'roles']);
  });

  it('contacts are protected by row-level security', async () => {
    const { orgA, user } = await ids();
    await asApp(null, async (c) => expect((await c.query('SELECT count(*)::int AS n FROM client_contacts')).rows[0].n).toBe(0));
    await asApp({ orgId: orgA, userId: user(EMAIL.technician), scopeAll: false }, async (c) => {
      const r = await c.query(`SELECT count(DISTINCT client_id)::int AS n FROM client_contacts`);
      expect(r.rows[0].n).toBe(4);
    });
  });
});

describe('services', () => {
  it('serves the database-driven catalog with Help Desk as the default', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const s = (await c.get('/services')).body;
    expect(s).toHaveLength(18);
    expect(s.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { key: string }) => x.key)).toEqual(['help_desk']);
    expect(s.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['soc_mdr', 'security_monitoring', 'custom_services', 'microsoft_365']));
  });

  it('assigns services to a client and audits the change', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00010');
    const catalog = (await ops.get('/services')).body as { id: string; key: string }[];
    const pick = (keys: string[]) => catalog.filter((s) => keys.includes(s.key)).map((s) => s.id);
    const r = await ops.put(`/clients/${id}/services`, { serviceIds: pick(['help_desk', 'backup_management']) });
    expect(r.status).toBe(200);
    expect(r.body.map((s: { key: string }) => s.key).sort()).toEqual(['backup_management', 'help_desk']);
    const ev = (await ops.get(`/clients/${id}/activity`)).body.items[0];
    expect(ev.action).toBe('client.services.updated');
    expect(ev.metadata.added).toContain('backup_management');
  });

  it('rejects unknown services and services from another organization', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00011');
    const { orgB } = await ids();
    const foreign = await asApp({ orgId: orgB, scopeAll: true }, async (c) => (await c.query(`SELECT id FROM services WHERE key = 'help_desk'`)).rows[0].id as string);
    expect((await ops.put(`/clients/${id}/services`, { serviceIds: [foreign] })).status).toBe(400);
    expect((await ops.put(`/clients/${id}/services`, { serviceIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400);
  });
});

describe('technician client assignments', () => {
  it('an administrator changes which clients a technician can see', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const { user } = await ids();
    const created = await admin.post('/users', { email: 'scope.tech@psacc.test', displayName: 'Scope Tech', roleKeys: ['technician'], initialPassword: 'Scope-Tech-Pass-1' });
    const techId = created.body.user.id as string;
    const tech = await signedIn(app, 'scope.tech@psacc.test', 'Scope-Tech-Pass-1');
    await tech.post('/auth/password', { currentPassword: 'Scope-Tech-Pass-1', newPassword: 'Scope-Tech-Pass-2' });
    expect((await tech.get('/clients')).body.total).toBe(0);

    const ids2 = [await clientId('CL-00012'), await clientId('CL-00013')];
    const r = await admin.put(`/users/${techId}/client-assignments`, { clientIds: ids2 });
    expect(r.status).toBe(200);
    expect(r.body.assignedClients.map((c: { code: string }) => c.code).sort()).toEqual(['CL-00012', 'CL-00013']);
    expect((await tech.get('/clients')).body.total).toBe(2); // takes effect immediately (RLS)
    expect((await admin.put(`/users/${techId}/client-assignments`, { clientIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(422);

    const ops = await signedIn(app, EMAIL.tech); // tech_admin lacks users.manage
    expect((await ops.put(`/users/${techId}/client-assignments`, { clientIds: [] })).status).toBe(403);
    void user;
  });
});

describe('cross-organization access', () => {
  it('organization B cannot read or modify organization A clients', async () => {
    const b = await signedIn(app, EMAIL.orgB);
    const id = await clientId('CL-00001');
    expect((await b.get(`/clients/${id}`)).status).toBe(404);
    expect((await b.get(`/clients/${id}/contacts`)).status).toBe(404);
    expect((await b.put(`/clients/${id}/services`, { serviceIds: [] })).status).toBe(404);
    expect((await b.post(`/clients/${id}/contacts`, { fullName: 'Intruder', email: 'x@y.example', roles: ['other'] })).status).toBe(404);
    expect((await b.get('/clients')).body.items.map((c: { displayName: string }) => c.displayName)).toEqual(['Zephyr Secret Holdings']);
  });
});


describe('last Super Administrator protection', () => {
  it('a custom role with roles.manage cannot disable or demote the only active Super Administrator', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const created = await admin.post('/users', { email: 'steward@psacc.test', displayName: 'User Steward', roleKeys: ['read_only'], initialPassword: 'Keeper-Pass-0001' });
    const stewardId = created.body.user.id as string;
    const { orgA, user } = await ids();
    // Custom (organization) role with user + role management, assigned through SQL (no role editor UI yet).
    const owner = new pg.Client({ connectionString: testEnv().MIGRATION_DATABASE_URL });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.org_id', $1, true), set_config('app.scope_all', 'on', true)`, [orgA]);
      const role = await owner.query(
        `INSERT INTO roles (organization_id, key, name, description, scope) VALUES ($1, 'user_steward', 'User Steward', 'Custom test role', 'all_clients') RETURNING id`,
        [orgA],
      );
      await owner.query(`INSERT INTO role_permissions (role_id, permission_key) SELECT $1, unnest(ARRAY['users.read', 'users.manage', 'roles.manage'])`, [role.rows[0].id]);
      await owner.query('INSERT INTO user_roles (organization_id, user_id, role_id) VALUES ($1, $2, $3)', [orgA, stewardId, role.rows[0].id]);
      await owner.query('COMMIT');
    } finally {
      await owner.end();
    }
    const steward = await signedIn(app, 'steward@psacc.test', 'Keeper-Pass-0001');
    await steward.post('/auth/password', { currentPassword: 'Keeper-Pass-0001', newPassword: 'Keeper-Pass-0002' });

    const disable = await steward.patch(`/users/${user(EMAIL.admin)}`, { status: 'disabled' });
    expect(disable.status).toBe(409);
    expect(disable.body.type).toBe('urn:psacc:problem:last-super-admin');
    const demote = await steward.patch(`/users/${user(EMAIL.admin)}`, { roleKeys: ['ops_admin'] });
    expect(demote.status).toBe(409);
    // Once a second active Super Administrator exists, the same change is allowed.
    const second = await steward.post('/users', { email: 'second.super@psacc.test', displayName: 'Second Super', roleKeys: ['super_admin'], initialPassword: 'Second-Super-Pass-1' });
    expect(second.status).toBe(201);
    expect((await steward.patch(`/users/${second.body.user.id}`, { status: 'disabled' })).status).toBe(200); // avery is still active
  });
});
