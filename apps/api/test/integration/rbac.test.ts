import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL, ids, orgAClientCount, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await app.close();
});

describe('role-based access control (server-enforced)', () => {
  it.each([
    [EMAIL.viewer, '/users', 403],
    [EMAIL.viewer, '/audit-events', 403],
    [EMAIL.viewer, '/roles', 403],
    [EMAIL.viewer, '/system/status', 403],
    [EMAIL.technician, '/users', 403],
    [EMAIL.technician, '/audit-events', 403],
    [EMAIL.service, '/audit-events', 403],
    [EMAIL.auditor, '/audit-events', 200],
    [EMAIL.auditor, '/users', 200],
    [EMAIL.security, '/audit-events', 200],
    [EMAIL.ops, '/users', 200],
    [EMAIL.tech, '/users', 403],
  ])('%s GET %s → %i', async (email, path, status) => {
    const c = await signedIn(app, email);
    expect((await c.get(path)).status).toBe(status);
  });

  it('read-only and auditor users cannot create users (and the denial is audited)', async () => {
    for (const email of [EMAIL.viewer, EMAIL.auditor]) {
      const c = await signedIn(app, email);
      const r = await c.post('/users', { email: `nope-${Date.now()}@psacc.test`, displayName: 'Nope', roleKeys: ['read_only'] });
      expect(r.status).toBe(403);
    }
    const admin = await signedIn(app, EMAIL.admin);
    const audit = await admin.get('/audit-events?action=access.denied&pageSize=100');
    expect(audit.body.items.some((e: { targetId: string }) => e.targetId === 'POST /api/v1/users')).toBe(true);
  });

  it('every role can read the dashboard', async () => {
    for (const email of Object.values(EMAIL).filter((e) => e.endsWith('@psacc.test'))) {
      const c = await signedIn(app, email);
      expect((await c.get('/dashboard/summary')).status).toBe(200);
    }
  });

  it('an Operations Administrator cannot grant Super Administrator or modify a Super Administrator', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const grant = await ops.post('/users', { email: 'escalate@psacc.test', displayName: 'Escalate', roleKeys: ['super_admin'] });
    expect(grant.status).toBe(403);
    const { user } = await ids();
    const edit = await ops.patch(`/users/${user(EMAIL.admin)}`, { status: 'disabled' });
    expect(edit.status).toBe(403);
  });

  it('nobody can change their own roles or status', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const { user } = await ids();
    const r = await admin.patch(`/users/${user(EMAIL.admin)}`, { roleKeys: ['read_only'] });
    expect(r.status).toBe(403);
    expect(r.body.type).toBe('urn:psacc:problem:self-modification');
  });

  it('role changes take effect immediately and revoke the target user’s sessions', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const created = await admin.post('/users', { email: 'role.change@psacc.test', displayName: 'Role Change', roleKeys: ['auditor'], initialPassword: 'Role-Change-Pass-1' });
    const target = await signedIn(app, 'role.change@psacc.test', 'Role-Change-Pass-1');
    expect((await target.post('/auth/password', { currentPassword: 'Role-Change-Pass-1', newPassword: 'Role-Change-Pass-2' })).status).toBe(200);
    expect((await target.get('/audit-events')).status).toBe(200);
    const patched = await admin.patch(`/users/${created.body.user.id}`, { roleKeys: ['read_only'] });
    expect(patched.status).toBe(200);
    expect(patched.body.roles.map((r: { key: string }) => r.key)).toEqual(['read_only']);
    expect((await target.get('/audit-events')).status).toBe(401); // session revoked
    const again = await signedIn(app, 'role.change@psacc.test', 'Role-Change-Pass-2');
    expect((await again.get('/audit-events')).status).toBe(403);
    const audit = await admin.get('/audit-events?action=user.roles.changed');
    expect(audit.body.items[0].metadata.changes.roles).toEqual({ from: ['auditor'], to: ['read_only'] });
  });

  it('disabling a user blocks sign-in and ends their sessions', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const created = await admin.post('/users', { email: 'disable.me@psacc.test', displayName: 'Disable Me', roleKeys: ['read_only'], initialPassword: 'Disable-Me-Pass-1' });
    const target = await signedIn(app, 'disable.me@psacc.test', 'Disable-Me-Pass-1');
    expect((await admin.patch(`/users/${created.body.user.id}`, { status: 'disabled' })).status).toBe(200);
    expect((await target.get('/auth/me')).status).toBe(401);
    const r = await signedIn(app, 'disable.me@psacc.test', 'Disable-Me-Pass-1').catch((e: Error) => e);
    expect(r).toBeInstanceOf(Error);
  });

  it('validates user administration input', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    expect((await admin.post('/users', { email: 'bad', displayName: 'X', roleKeys: [] })).status).toBe(400);
    expect((await admin.post('/users', { email: 'unknown.role@psacc.test', displayName: 'Unknown Role', roleKeys: ['emperor'] })).status).toBe(422);
    const dup = await admin.post('/users', { email: EMAIL.viewer, displayName: 'Duplicate', roleKeys: ['read_only'] });
    expect(dup.status).toBe(409);
    expect((await admin.get('/users/not-a-uuid')).status).toBe(400);
    expect((await admin.get('/users/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await admin.get('/users?sort=email;drop')).status).toBe(400);
  });

  it('supports server-side search, filtering, sorting and pagination of users', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const page = await admin.get('/users?pageSize=3&page=1&sort=email:asc');
    expect(page.body.items).toHaveLength(3);
    expect(page.body.total).toBeGreaterThanOrEqual(8);
    const emails = page.body.items.map((u: { email: string }) => u.email);
    expect([...emails].sort()).toEqual(emails);
    const search = await admin.get('/users?q=riley');
    expect(search.body.items.map((u: { email: string }) => u.email)).toEqual([EMAIL.technician]);
    const role = await admin.get('/users?role=auditor');
    expect(role.body.items.every((u: { roles: { key: string }[] }) => u.roles.some((r) => r.key === 'auditor'))).toBe(true);
  });
});

describe('client scope (technicians see assigned clients only)', () => {
  it('technician dashboard and search are limited to the 4 assigned clients', async () => {
    const tech = await signedIn(app, EMAIL.technician);
    const viewer = await signedIn(app, EMAIL.viewer);
    const t = (await tech.get('/dashboard/summary')).body;
    const v = (await viewer.get('/dashboard/summary')).body;
    expect(t.kpis.totalClients).toBe(4);
    expect(v.kpis.totalClients).toBe(await orgAClientCount());
    expect(t.kpis.totalPsaInstances).toBeLessThan(v.kpis.totalPsaInstances);
    expect((await tech.get('/auth/me')).body.clientScope).toBe('assigned_clients');
    // Bluepeak (index 0) is assigned; Harbor & Finch (index 1) is not.
    expect((await tech.get('/search?q=Bluepeak')).body.results.length).toBeGreaterThan(0);
    expect((await tech.get('/search?q=Harbor')).body.results).toEqual([]);
    expect((await viewer.get('/search?q=Harbor')).body.results.length).toBeGreaterThan(0);
  });
});
