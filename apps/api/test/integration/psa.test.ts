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

async function clientId(code: string) {
  const { orgA } = await ids();
  return asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query('SELECT id FROM clients WHERE code = $1', [code])).rows[0].id as string);
}

describe('PSA providers', () => {
  it('exposes the 7 provider descriptors with config fields, auth methods (labels only) and honest adapter status', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const r = await c.get('/psa-providers');
    expect(r.body.map((p: { key: string }) => p.key)).toEqual(['autotask', 'connectwise', 'halopsa', 'kaseya_bms', 'freshservice', 'servicenow', 'custom_rest']);
    for (const p of r.body) {
      expect(p.adapterStatus).toBe('config_only');
      expect(p.configFields.length).toBeGreaterThan(0);
      for (const m of p.authMethods) for (const f of m.credentialFields) expect(Object.keys(f).sort()).toEqual(['key', 'label', 'secret']);
    }
  });

  it('validates a configuration and previews the endpoint without storing anything', async () => {
    const c = await signedIn(app, EMAIL.ops);
    const ok = await c.post('/psa-providers/connectwise/validate', { authMethod: 'api_member_keys', config: { site: 'au', companyId: 'acme' } });
    expect(ok.body).toMatchObject({ ok: true, endpoint: 'https://api-au.myconnectwise.net/v4_6_release/apis/3.0' });
    const bad = await c.post('/psa-providers/connectwise/validate', { authMethod: 'api_member_keys', config: { site: 'onprem' } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.issues.map((i: { path: string }) => i.path).sort()).toEqual(['config.companyId', 'config.onPremHost']);
    expect((await c.post('/psa-providers/jira/validate', { authMethod: 'x', config: {} })).status).toBe(422);
  });
});

describe('PSA instances', () => {
  it('lists, searches, filters and sorts on the server, scoped to the caller', async () => {
    const v = await signedIn(app, EMAIL.viewer);
    const all = await v.get('/psa-instances?pageSize=100');
    expect(all.body.total).toBeGreaterThanOrEqual(29);
    const cw = await v.get('/psa-instances?provider=connectwise&pageSize=100');
    expect(cw.body.items.every((i: { providerKey: string }) => i.providerKey === 'connectwise')).toBe(true);
    expect((await v.get('/psa-instances?q=Bluepeak')).body.items[0].client.displayName).toBe('Bluepeak Logistics');
    // "Succeeded" only ever comes from a real test reported by an appliance (Module 11): every such instance carries the time of that success.
    const succeeded = (await v.get('/psa-instances?connectionStatus=succeeded&pageSize=100')).body.items as { lastSuccessfulTestAt: string | null; isSynthetic: boolean }[];
    expect(succeeded.every((i) => i.lastSuccessfulTestAt !== null && !i.isSynthetic)).toBe(true);
    const sorted = (await v.get('/psa-instances?sort=client:desc&pageSize=3')).body.items.map((i: { client: { displayName: string } }) => i.client.displayName);
    expect([...sorted].sort().reverse()).toEqual(sorted);
    const t = await signedIn(app, EMAIL.technician);
    const tl = await t.get('/psa-instances?pageSize=100');
    expect(new Set(tl.body.items.map((i: { client: { id: string } }) => i.client.id)).size).toBe(4);
  });

  it('detail includes config, enabled services, deployments and no secrets', async () => {
    const v = await signedIn(app, EMAIL.viewer);
    const first = (await v.get('/psa-instances?q=PSA-00001')).body.items[0];
    const d = (await v.get(`/psa-instances/${first.id}`)).body;
    expect(d.code).toBe('PSA-00001');
    expect(d.config.zone).toMatch(/^webservices\d+$/);
    expect(d.apiEndpoint).toMatch(/^https:\/\/webservices\d+\.autotask\.net\/ATServicesRest$/);
    expect(d.enabledServices.map((s: { key: string }) => s.key)).toContain('help_desk');
    expect(d.deployments.some((x: { boundHere: boolean }) => x.boundHere)).toBe(true);
    expect(d.version).toMatch(/^\d+$/);
    expect(JSON.stringify(d)).not.toMatch(/secret"|password"|privateKey|clientSecret/i);
  });

  it('creates an instance through the provider adapter; read-only users and technicians cannot', async () => {
    const id = await clientId('CL-00014');
    const body = { clientId: id, providerKey: 'halopsa', displayName: 'Orchid Bay — Halo', authMethod: 'oauth2_client_credentials', config: { tenantUrl: 'https://orchid.halopsa.example' } };
    for (const email of [EMAIL.viewer, EMAIL.technician, EMAIL.service]) {
      expect((await (await signedIn(app, email)).post('/psa-instances', body)).status).toBe(403);
    }
    const ops = await signedIn(app, EMAIL.ops);
    const r = await ops.post('/psa-instances', body);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      code: expect.stringMatching(/^PSA-\d{5}$/), providerKey: 'halopsa', apiEndpoint: 'https://orchid.halopsa.example/api',
      connectionStatus: 'untested', credentialStatus: 'pending_appliance', status: 'active', isSynthetic: false,
    });
    expect(r.body.config).toEqual({ tenantUrl: 'https://orchid.halopsa.example', scope: 'all' });
    // A client may have several instances, but names are unique per client (case-insensitive).
    const dup = await ops.post('/psa-instances', { ...body, displayName: 'orchid bay — HALO' });
    expect(dup.status).toBe(400);
    expect(dup.body.errors[0].path).toBe('displayName');
    const activity = (await ops.get(`/psa-instances/${r.body.id}/activity`)).body.items;
    expect(activity[0]).toMatchObject({ action: 'psa_instance.created', metadata: expect.objectContaining({ provider: 'halopsa', connectionStatus: 'untested' }) });
  });

  it('validates provider configuration, auth method, client and services', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const id = await clientId('CL-00015');
    const base = { clientId: id, providerKey: 'autotask', displayName: 'Quarry Lane — AT 2', authMethod: 'api_user', config: { zone: 'webservices3' } };
    expect((await ops.post('/psa-instances', { ...base, config: { zone: 'webservices99' } })).body.errors[0].path).toBe('config.zone');
    expect((await ops.post('/psa-instances', { ...base, authMethod: 'basic' })).body.errors[0].path).toBe('authMethod');
    const smuggle = await ops.post('/psa-instances', { ...base, config: { zone: 'webservices3', secret: 'hunter2' } });
    expect(smuggle.status).toBe(400);
    expect(smuggle.body.errors[0].message).toMatch(/Credentials are never stored/);
    expect((await ops.post('/psa-instances', { ...base, clientId: '00000000-0000-4000-8000-000000000000' })).body.errors[0].path).toBe('clientId');
    const unassigned = (await ops.get('/services')).body.find((s: { key: string }) => s.key === 'procurement').id;
    const svc = await ops.post('/psa-instances', { ...base, enabledServiceIds: [unassigned] });
    expect(svc.status).toBe(400);
    expect(svc.body.errors[0].path).toBe('enabledServiceIds');
    expect((await ops.post('/psa-instances', { ...base, providerKey: 'zendesk' })).status).toBe(400);
  });

  it('updates with optimistic concurrency; changing the endpoint resets connectivity to untested and is audited', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const inst = (await ops.get('/psa-instances?q=PSA-00002')).body.items[0];
    const d = (await ops.get(`/psa-instances/${inst.id}`)).body;
    const body = (over: object) => ({ version: d.version, displayName: d.displayName, authMethod: d.authMethod, config: d.config, notes: d.notes ?? undefined, enabledServiceIds: d.enabledServices.map((s: { id: string }) => s.id), status: d.status, ...over });
    const r = await ops.patch(`/psa-instances/${inst.id}`, body({ config: { ...d.config, site: 'eu' } }));
    expect(r.status).toBe(200);
    expect(r.body.apiEndpoint).toBe('https://api-eu.myconnectwise.net/v4_6_release/apis/3.0');
    expect(r.body.connectionStatus).toBe('untested');
    expect((await ops.patch(`/psa-instances/${inst.id}`, body({ displayName: 'Stale write' }))).status).toBe(409);
    const ev = (await ops.get(`/psa-instances/${inst.id}/activity`)).body.items[0];
    expect(ev.action).toBe('psa_instance.updated');
    expect(ev.metadata.changes.config.site).toEqual({ from: 'na', to: 'eu' });
    expect(ev.metadata.changes.apiEndpoint.to).toBe('https://api-eu.myconnectwise.net/v4_6_release/apis/3.0');
  });

  it('read-only users, technicians, service managers and auditors cannot edit an instance', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const inst = (await ops.get('/psa-instances?q=PSA-00003')).body.items[0];
    const d = (await ops.get(`/psa-instances/${inst.id}`)).body;
    const body = { version: d.version, displayName: 'Not allowed', authMethod: d.authMethod, config: d.config, enabledServiceIds: [], status: d.status };
    for (const email of [EMAIL.viewer, EMAIL.technician, EMAIL.service, EMAIL.auditor]) {
      expect((await (await signedIn(app, email)).patch(`/psa-instances/${inst.id}`, body)).status, email).toBe(403);
    }
    expect((await ops.get(`/psa-instances/${inst.id}`)).body.displayName).toBe(d.displayName);
  });

  it('connectivity cannot be marked verified without a real test (database constraint)', async () => {
    const { orgA } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await expect(c.query(`UPDATE psa_instances SET connection_status = 'succeeded'`)).rejects.toThrow(/psa_instances_verified_requires_test/);
    });
  });
});

describe('deployment association', () => {
  it('moves a deployment between PSA instances of the same client; refuses other clients and disabled instances', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const meridian = await clientId('CL-00005'); // has a ConnectWise and a ServiceNow instance, and two deployments
    const instances = (await ops.get(`/psa-instances?clientId=${meridian}`)).body.items as { id: string; code: string; providerKey: string }[];
    expect(instances.length).toBeGreaterThanOrEqual(2);
    const sn = instances.find((i) => i.providerKey === 'servicenow')!;
    const cw = instances.find((i) => i.providerKey === 'connectwise')!;
    const dep = (await ops.get(`/psa-instances/${cw.id}`)).body.deployments.find((d: { boundHere: boolean }) => d.boundHere);

    const moved = await ops.put(`/deployments/${dep.id}/psa-instance`, { psaInstanceId: sn.id });
    expect(moved.body).toMatchObject({ changed: true });
    expect((await ops.get(`/psa-instances/${sn.id}`)).body.deployments.find((d: { id: string }) => d.id === dep.id).boundHere).toBe(true);
    expect((await ops.get(`/clients/${meridian}/activity`)).body.items[0]).toMatchObject({ action: 'deployment.psa_instance.changed', metadata: { from: cw.code, to: sn.code } });

    // Another client's instance is refused.
    const other = (await ops.get('/psa-instances?q=PSA-00001')).body.items[0];
    expect((await ops.put(`/deployments/${dep.id}/psa-instance`, { psaInstanceId: other.id })).status).toBe(400);

    // An instance still used by a deployment cannot be disabled …
    const snDetail = (await ops.get(`/psa-instances/${sn.id}`)).body;
    const disable = await ops.patch(`/psa-instances/${sn.id}`, { version: snDetail.version, displayName: snDetail.displayName, authMethod: snDetail.authMethod, config: snDetail.config, enabledServiceIds: [], status: 'disabled' });
    expect(disable.status).toBe(409);
    expect(disable.body.type).toBe('urn:psacc:problem:instance-in-use');
    // … and once moved back, it can — after which it cannot receive deployments.
    expect((await ops.put(`/deployments/${dep.id}/psa-instance`, { psaInstanceId: cw.id })).status).toBe(200);
    const fresh = (await ops.get(`/psa-instances/${sn.id}`)).body;
    expect((await ops.patch(`/psa-instances/${sn.id}`, { version: fresh.version, displayName: fresh.displayName, authMethod: fresh.authMethod, config: fresh.config, enabledServiceIds: [], status: 'disabled' })).status).toBe(200);
    const refused = await ops.put(`/deployments/${dep.id}/psa-instance`, { psaInstanceId: sn.id });
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0].message).toMatch(/Disabled/);
  });

  it('read-only users cannot change associations', async () => {
    const v = await signedIn(app, EMAIL.viewer);
    const inst = (await v.get('/psa-instances?q=PSA-00001')).body.items[0];
    const dep = (await v.get(`/psa-instances/${inst.id}`)).body.deployments[0];
    expect((await v.put(`/deployments/${dep.id}/psa-instance`, { psaInstanceId: inst.id })).status).toBe(403);
  });
});

describe('PSA isolation', () => {
  it('organization B cannot see, configure or bind organization A instances', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const a = (await ops.get('/psa-instances?q=PSA-00001')).body.items[0];
    const b = await signedIn(app, EMAIL.orgB);
    expect((await b.get(`/psa-instances/${a.id}`)).status).toBe(404);
    expect((await b.get('/psa-instances?pageSize=100')).body.items.map((i: { displayName: string }) => i.displayName)).toEqual(['Zephyr ConnectWise']);
    const bDep = await (async () => {
      const { orgB } = await ids();
      return asApp({ orgId: orgB, scopeAll: true }, async (c) => (await c.query('SELECT id FROM deployments LIMIT 1')).rows[0].id as string);
    })();
    expect((await b.put(`/deployments/${bDep}/psa-instance`, { psaInstanceId: a.id })).status).toBe(400);
    await asApp(null, async (c) => expect((await c.query('SELECT count(*)::int AS n FROM psa_instance_services')).rows[0].n).toBe(0));
  });
});
