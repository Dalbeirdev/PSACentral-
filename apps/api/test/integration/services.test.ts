import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL, asApp, ids, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await app.close();
});

describe('service catalog (Module 4)', () => {
  it('lists the database-driven catalog with usage counts and filters on the server', async () => {
    const v = await signedIn(app, EMAIL.viewer);
    const all = (await v.get('/services')).body as { key: string; isActive: boolean; clientCount: number; category: { key: string }; configRequirements: unknown[]; integrationDependencies: string[] }[];
    expect(all.length).toBeGreaterThanOrEqual(18);
    const helpDesk = all.find((s) => s.key === 'help_desk')!;
    expect(helpDesk.clientCount).toBeGreaterThan(0);
    expect(helpDesk.configRequirements.map((r) => (r as { key: string }).key)).toEqual(['defaultPriority', 'supportHours']);
    expect((await v.get('/services?category=security')).body.every((s: { category: { key: string } }) => s.category.key === 'security')).toBe(true);
    expect((await v.get('/services?dependency=rmm')).body.map((s: { key: string }) => s.key).sort()).toEqual(['endpoint_management', 'patch_management']);
    expect((await v.get('/services?usesPsa=1')).body.every((s: { requiresPsa: boolean }) => s.requiresPsa)).toBe(true);
    expect((await v.get('/services?q=patch')).body.map((s: { key: string }) => s.key)).toEqual(['patch_management']);
    expect((await v.get('/services?status=archived')).status).toBe(400);
    const cats = (await v.get('/service-categories')).body as { key: string; serviceCount: number; activeServiceCount: number }[];
    expect(cats.map((c) => c.key)).toEqual(['support', 'endpoint', 'security', 'infrastructure', 'business', 'custom']);
    expect(cats.reduce((n, c) => n + c.serviceCount, 0)).toBe(all.length);
  });

  it('creates, updates (optimistic version, immutable key) and audits a service; validation refuses secrets and inconsistent PSA flags', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const cats = (await ops.get('/service-categories')).body as { id: string; key: string }[];
    const security = cats.find((c) => c.key === 'security')!;
    const bad = await ops.post('/services', { key: 'dark_web_monitoring', name: 'Dark Web Monitoring', categoryId: security.id, requiresPsa: false, integrationDependencies: ['psa.tickets'] });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(['requiresPsa']);
    const secret = await ops.post('/services', {
      key: 'dark_web_monitoring', name: 'Dark Web Monitoring', categoryId: security.id,
      configRequirements: [{ key: 'apiToken', label: 'Vendor API token', type: 'text', required: true }],
    });
    expect(secret.status).toBe(400);
    expect(secret.body.errors[0].path).toBe('configRequirements.0.key');

    const created = await ops.post('/services', {
      key: 'dark_web_monitoring', name: 'Dark Web Monitoring', description: 'Credential exposure monitoring.', categoryId: security.id, requiresPsa: true,
      integrationDependencies: ['psa.tickets', 'edr'], sortOrder: 125,
      configRequirements: [
        { key: 'monitoredDomains', label: 'Monitored domains', type: 'text', required: true, description: 'Comma-separated.' },
        { key: 'alertSeverity', label: 'Alert severity', type: 'select', required: false, options: [{ value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' }] },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ key: 'dark_web_monitoring', isActive: true, isDefault: false, clientCount: 0, deploymentCount: 0, category: { key: 'security' } });
    expect(created.body.createdBy).toBeTruthy();
    expect((await ops.post('/services', { key: 'dark_web_monitoring', name: 'Dup', categoryId: security.id })).body.errors[0].path).toBe('key');

    const v1 = created.body.version as string;
    const updated = await ops.patch(`/services/${id}`, {
      version: v1, name: 'Dark Web Monitoring', description: 'Credential exposure monitoring and takedown.', categoryId: security.id, requiresPsa: true,
      integrationDependencies: ['psa.tickets', 'edr'], sortOrder: 126, configRequirements: created.body.configRequirements,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.version).not.toBe(v1);
    expect((await ops.patch(`/services/${id}`, { version: v1, name: 'Stale', categoryId: security.id })).status).toBe(409);
    expect((await ops.patch(`/services/${id}`, { version: updated.body.version, key: 'renamed', name: 'X', categoryId: security.id })).status).toBe(400); // key is immutable

    const audit = await ops.get(`/services/${id}/activity`);
    expect(audit.body.items.map((e: { action: string }) => e.action)).toEqual(['service.updated', 'service.created']);
    expect(audit.body.items[0].metadata.changes).toMatchObject({ description: { from: 'Credential exposure monitoring.', to: 'Credential exposure monitoring and takedown.' }, sortOrder: { from: 125, to: 126 } });
    expect((await ops.get('/audit-events?action=service.created')).body.total).toBeGreaterThanOrEqual(1);
  });

  it('assignment enforces configuration requirements; values flow into the deployment readiness and package configuration', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    // Any deployment and its client: readiness is computed for synthetic sample deployments too (their 'record' check fails, the rest is real).
    const dep = (await ops.get('/deployments')).body.items[0] as { id: string; client: { id: string; code: string } };
    const client = dep.client.id;
    const svc = (await ops.get('/services?q=dark_web')).body[0] as { id: string; key: string };
    const current = (await ops.get(`/clients/${client}/services`)).body as { id: string; key: string; config: Record<string, unknown> }[];
    const ids = [...current.map((s) => s.id), svc.id];

    const missing = await ops.put(`/clients/${client}/services`, { serviceIds: ids });
    expect(missing.status).toBe(400);
    expect(missing.body.errors).toEqual([{ path: `config.${svc.id}.monitoredDomains`, message: 'Monitored domains is required.' }]);
    const wrong = await ops.put(`/clients/${client}/services`, { serviceIds: ids, config: { [svc.id]: { monitoredDomains: 'acme.example', alertSeverity: 'low' } } });
    expect(wrong.body.errors[0].path).toBe(`config.${svc.id}.alertSeverity`);

    const ok = await ops.put(`/clients/${client}/services`, { serviceIds: ids, config: { [svc.id]: { monitoredDomains: ' acme.example, acme.test ', alertSeverity: 'critical' } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const assigned = ok.body.find((s: { id: string }) => s.id === svc.id);
    expect(assigned.config).toEqual({ monitoredDomains: 'acme.example, acme.test', alertSeverity: 'critical' });
    expect(assigned.configIssues).toEqual([]);
    // Existing assignments keep their values when the request does not mention them.
    for (const c of current) expect(ok.body.find((s: { id: string }) => s.id === c.id).config).toEqual(c.config);

    const detail = (await ops.get(`/services/${svc.id}`)).body;
    expect(detail.clientCount).toBe(1);
    expect(detail.clients[0]).toMatchObject({ code: dep.client.code, configComplete: true });
    const activity = (await ops.get(`/services/${svc.id}/activity`)).body;
    expect(activity.items[0]).toMatchObject({ action: 'client.services.updated', targetType: 'client' });
    expect(activity.items[0].metadata.added).toEqual(['dark_web_monitoring']);

    // A deployment of the client sees the service and its settings; a required setting removed later shows as incomplete.
    const d = (await ops.get(`/deployments/${dep.id}`)).body;
    const onDep = d.services.find((s: { key: string }) => s.key === 'dark_web_monitoring');
    expect(onDep).toMatchObject({ configComplete: true, requiresPsa: true });
    expect(d.readiness.find((c: { key: string }) => c.key === 'service_config')).toMatchObject({ ok: true });

    const tighter = (await ops.get(`/services/${svc.id}`)).body;
    const stricter = await ops.patch(`/services/${svc.id}`, {
      version: tighter.version, name: tighter.name, description: tighter.description, categoryId: tighter.category.id, requiresPsa: true,
      integrationDependencies: tighter.integrationDependencies, sortOrder: tighter.sortOrder,
      configRequirements: [...tighter.configRequirements, { key: 'escalationContact', label: 'Escalation contact', type: 'text', required: true }],
    });
    expect(stricter.status).toBe(200);
    expect(stricter.body.clients[0].configComplete).toBe(false);
    const after = (await ops.get(`/deployments/${dep.id}`)).body;
    expect(after.readiness.find((c: { key: string }) => c.key === 'service_config')).toMatchObject({ ok: false });
    expect(after.readiness.find((c: { key: string }) => c.key === 'service_config').detail).toContain('Dark Web Monitoring');
    const issues = (await ops.get(`/clients/${client}/services`)).body.find((s: { id: string }) => s.id === svc.id).configIssues;
    expect(issues).toEqual([{ path: 'escalationContact', message: 'Escalation contact is required.' }]);
  });

  it('deactivation keeps assignments but refuses new ones; defaults cannot be deactivated; reactivation works', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const svc = (await ops.get('/services?q=dark_web')).body[0] as { id: string; version: string };
    const d = (await ops.get(`/services/${svc.id}`)).body;
    const off = await ops.post(`/services/${svc.id}/deactivate`, { version: d.version });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ isActive: false, clientCount: 1 });
    expect((await ops.get('/services?status=inactive')).body.map((s: { id: string }) => s.id)).toContain(svc.id);
    expect((await ops.get('/services?status=active')).body.map((s: { id: string }) => s.id)).not.toContain(svc.id);

    // Still assigned to its client (and savable there), but another client cannot add it.
    const a = (await ops.get(`/services/${svc.id}`)).body.clients[0].id as string;
    const mine = (await ops.get(`/clients/${a}/services`)).body as { id: string; isActive: boolean }[];
    expect(mine.find((s) => s.id === svc.id)!.isActive).toBe(false);
    // Saving the client's services with the inactive one kept works, once the stricter requirement from the previous test is satisfied.
    const keep = await ops.put(`/clients/${a}/services`, { serviceIds: mine.map((s) => s.id) });
    expect(keep.status).toBe(400);
    expect(keep.body.errors[0].path).toBe(`config.${svc.id}.escalationContact`);
    const kept = await ops.put(`/clients/${a}/services`, { serviceIds: mine.map((s) => s.id), config: { [svc.id]: { monitoredDomains: 'acme.example', alertSeverity: 'critical', escalationContact: 'soc@acme.example' } } });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.find((s: { id: string }) => s.id === svc.id).configIssues).toEqual([]);
    const b = (await ops.get(`/clients?pageSize=100&status=active`)).body.items.find((c: { id: string }) => c.id !== a).id as string;
    const theirs = (await ops.get(`/clients/${b}/services`)).body as { id: string }[];
    const refused = await ops.put(`/clients/${b}/services`, { serviceIds: [...theirs.map((s) => s.id), svc.id], config: { [svc.id]: { monitoredDomains: 'x', escalationContact: 'y' } } });
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0].message).toMatch(/inactive/);

    const helpDesk = (await ops.get('/services?q=help_desk')).body[0];
    const isDefault = await ops.post(`/services/${helpDesk.id}/deactivate`, { version: (await ops.get(`/services/${helpDesk.id}`)).body.version });
    expect(isDefault.status).toBe(409);
    expect(isDefault.body.type).toBe('urn:psacc:problem:service-is-default');
    const stale = await ops.post(`/services/${svc.id}/activate`, { version: d.version });
    expect(stale.status).toBe(409);
    const on = await ops.post(`/services/${svc.id}/activate`, { version: off.body.version });
    expect(on.body.isActive).toBe(true);
    const actions = (await ops.get(`/services/${svc.id}/activity`)).body.items.map((e: { action: string }) => e.action);
    expect(actions[0]).toBe('service.activated');
    expect(actions).toContain('service.deactivated');
    expect(actions).toContain('client.services.updated'); // the configuration save above involved this service
  });

  it('categories: create, rename/reorder with version, delete only when empty; services need an existing category', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const created = await ops.post('/service-categories', { key: 'compliance', name: 'Compliance', sortOrder: 60 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await ops.post('/service-categories', { key: 'compliance', name: 'Again' })).body.errors[0].path).toBe('key');
    const renamed = await ops.patch(`/service-categories/${created.body.id}`, { version: created.body.version, name: 'Compliance & GRC', sortOrder: 55 });
    expect(renamed.status).toBe(200);
    expect((await ops.patch(`/service-categories/${created.body.id}`, { version: created.body.version, name: 'Stale', sortOrder: 55 })).status).toBe(409);
    const list = (await ops.get('/service-categories')).body as { key: string; name: string }[];
    expect(list.map((c) => c.key)).toEqual(['support', 'endpoint', 'security', 'infrastructure', 'business', 'compliance', 'custom']);

    const security = list.find((c) => c.key === 'security')!;
    const inUse = await ops.send('delete', `/service-categories/${(await ops.get('/service-categories')).body.find((c: { key: string }) => c.key === 'security').id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.type).toBe('urn:psacc:problem:category-in-use');
    expect(security.name).toBe('Security');
    expect((await ops.send('delete', `/service-categories/${created.body.id}`)).status).toBe(204);
    expect((await ops.get('/service-categories')).body.some((c: { key: string }) => c.key === 'compliance')).toBe(false);
    expect((await ops.post('/services', { key: 'orphan', name: 'Orphan', categoryId: created.body.id })).body.errors[0].path).toBe('categoryId');
    expect((await ops.get('/audit-events?action=service_category.deleted')).body.total).toBeGreaterThanOrEqual(1);
  });

  it('RBAC: read-only roles see the catalog but cannot change it; only services.write roles can', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const svc = (await ops.get('/services?q=dark_web')).body[0] as { id: string };
    const d = (await ops.get(`/services/${svc.id}`)).body;
    const body = { version: d.version, name: 'Not allowed', categoryId: d.category.id, requiresPsa: true, integrationDependencies: d.integrationDependencies, configRequirements: d.configRequirements };
    expect((await (await signedIn(app, EMAIL.security)).get('/services')).status, 'security admin has no catalog access').toBe(403);
    for (const email of [EMAIL.viewer, EMAIL.technician, EMAIL.auditor, EMAIL.tech]) {
      const c = await signedIn(app, email);
      expect((await c.get('/services')).status, `${email} read`).toBe(200);
      expect((await c.patch(`/services/${svc.id}`, body)).status, `${email} patch`).toBe(403);
      expect((await c.post('/services', { key: 'nope', name: 'Nope', categoryId: d.category.id })).status, `${email} post`).toBe(403);
      expect((await c.post(`/services/${svc.id}/deactivate`, { version: d.version })).status, `${email} deactivate`).toBe(403);
      expect((await c.post('/service-categories', { key: 'nope', name: 'Nope' })).status, `${email} category`).toBe(403);
    }
    // Service managers administer the catalog (services.write) even though they do not manage deployments.
    const svcMgr = await signedIn(app, EMAIL.service);
    const r = await svcMgr.patch(`/services/${svc.id}`, { ...body, name: d.name });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await ops.get(`/services/${svc.id}`)).body.name).toBe(d.name);
  });

  it('tenant isolation: the catalog, categories and audit history are per organization', async () => {
    const a = await signedIn(app, EMAIL.ops);
    const b = await signedIn(app, EMAIL.orgB);
    const svc = (await a.get('/services?q=dark_web')).body[0] as { id: string };
    expect((await b.get('/services')).body.some((s: { key: string }) => s.key === 'dark_web_monitoring')).toBe(false);
    expect((await b.get(`/services/${svc.id}`)).status).toBe(404);
    expect((await b.get(`/services/${svc.id}/activity`)).status).toBe(404);
    expect((await b.patch(`/services/${svc.id}`, { version: '1', name: 'Cross org', categoryId: svc.id })).status).toBe(404);
    const catsA = (await a.get('/service-categories')).body as { id: string; key: string }[];
    const catsB = (await b.get('/service-categories')).body as { id: string; key: string }[];
    expect(catsB.map((c) => c.key)).toEqual(catsA.map((c) => c.key));
    expect(catsB.some((c) => catsA.some((x) => x.id === c.id))).toBe(false);
    expect((await b.send('delete', `/service-categories/${catsA[0]!.id}`)).status).toBe(404);
    expect((await b.post('/services', { key: 'cross', name: 'Cross', categoryId: catsA[0]!.id })).body.errors[0].path).toBe('categoryId');
    // The application role is bound by RLS even for direct SQL.
    const { orgB } = await ids();
    const seen = await asApp({ orgId: orgB, scopeAll: true }, async (c) => (await c.query('SELECT count(*)::int AS n FROM services WHERE key = $1', ['dark_web_monitoring'])).rows[0].n as number);
    expect(seen).toBe(0);
    const { orgA } = await ids();
    const mine = await asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query('SELECT count(*)::int AS n FROM audit_events WHERE target_type = $1', ['service'])).rows[0].n as number);
    expect(mine).toBeGreaterThan(0);
    const theirs = await asApp({ orgId: orgB, scopeAll: true }, async (c) => (await c.query('SELECT count(*)::int AS n FROM audit_events WHERE target_type = $1', ['service'])).rows[0].n as number);
    expect(theirs).toBe(0);
  });
});
