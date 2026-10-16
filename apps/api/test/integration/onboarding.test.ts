import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, EMAIL, asApp, ids, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
let services: { id: string; key: string }[];
beforeAll(async () => {
  app = await startApp();
  services = (await (await signedIn(app, EMAIL.viewer)).get('/services')).body;
});
afterAll(async () => {
  await app.close();
});

const svc = (...keys: string[]) => services.filter((s) => keys.includes(s.key)).map((s) => s.id);

function clientStep(reference: string, name = `Test Client ${reference}`) {
  return {
    company: {
      legalName: `${name} Ltd`, displayName: name, clientReference: reference, businessType: 'Technology',
      countryCode: 'US', stateRegion: 'Texas', city: 'Austin', timezone: 'America/Chicago', website: 'https://test-client.example',
    },
    management: { contractStartDate: '2026-10-01', contractEndDate: '2027-09-30', internalNotes: 'Synthetic test data.' },
    contacts: [
      { fullName: 'Pat Primary', email: `pat.${reference.toLowerCase()}@client.example`, roles: ['primary'], phone: '+1 555 0100' },
      { fullName: 'Tess Technical', email: `tess.${reference.toLowerCase()}@client.example`, roles: ['technical', 'escalation'] },
    ],
  };
}

async function newDraft(c: Client) {
  const r = await c.post('/onboarding/drafts');
  expect(r.status).toBe(201);
  return { id: r.body.id as string, version: r.body.version as number };
}

async function saveAll(c: Client, draft: { id: string; version: number }, reference: string, provider = 'autotask', serviceKeys = ['help_desk', 'endpoint_management']) {
  const steps: [string, unknown][] = [
    ['client', clientStep(reference)],
    ['psa-provider', { providerKey: provider }],
    ['psa-config', { displayName: `${reference} — PSA`, authMethod: provider === 'autotask' ? 'api_user' : 'api_member_keys', config: provider === 'autotask' ? { zone: 'webservices5' } : { site: 'na', companyId: 'testclient' } }],
    ['services', { serviceIds: svc(...serviceKeys) }],
    ['deployment', { targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'psa-edge-01' }],
  ];
  for (const [step, data] of steps) {
    const r = await c.put(`/onboarding/drafts/${draft.id}/steps/${step}`, { version: draft.version, data });
    expect(r.status, `${step}: ${JSON.stringify(r.body)}`).toBe(200);
    draft.version = r.body.version;
  }
  return draft;
}

describe('onboarding permissions', () => {
  it.each([EMAIL.viewer, EMAIL.technician, EMAIL.auditor, EMAIL.tech])('%s cannot start an onboarding', async (email) => {
    const c = await signedIn(app, email);
    expect((await c.post('/onboarding/drafts')).status).toBe(403);
  });

  it('a Service Manager can prepare a draft but cannot create PSA/deployment records', async () => {
    const sm = await signedIn(app, EMAIL.service);
    const d = await saveAll(sm, await newDraft(sm), 'SM-PREP-1');
    const r = await sm.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true });
    expect(r.status).toBe(403);
    // An Operations Administrator can finish the shared draft.
    const ops = await signedIn(app, EMAIL.ops);
    expect((await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true })).status).toBe(200);
  });
});

describe('draft persistence & validation', () => {
  it('saves steps server-side and resumes from the next step', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    const r = await ops.put(`/onboarding/drafts/${d.id}/steps/client`, { version: d.version, data: clientStep('RESUME-1', 'Resume Corp') });
    expect(r.body.currentStep).toBe('psa-provider');
    expect(r.body.completedSteps).toEqual(['client']);
    // A new session (e.g. tomorrow, another browser) sees the same draft.
    const again = await signedIn(app, EMAIL.ops);
    const g = await again.get(`/onboarding/drafts/${d.id}`);
    expect(g.body.data.client.company.displayName).toBe('Resume Corp');
    expect(g.body.version).toBe(r.body.version);
    const list = await again.get('/onboarding/drafts');
    expect(list.body.find((x: { id: string }) => x.id === d.id)).toMatchObject({ clientName: 'Resume Corp', currentStep: 'psa-provider' });
  });

  it('returns field-level errors with paths', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    const bad = clientStep('BAD-1');
    bad.company.website = 'not a url';
    bad.contacts = [{ ...bad.contacts[0]!, roles: ['technical'] }, { ...bad.contacts[1]!, email: bad.contacts[0]!.email }];
    const r = await ops.put(`/onboarding/drafts/${d.id}/steps/client`, { version: d.version, data: bad });
    expect(r.status).toBe(400);
    const paths = r.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['company.website', 'contacts', 'contacts.1.email']));
    expect(r.body.errors.find((e: { path: string }) => e.path === 'contacts').message).toBe('Mark one contact as the primary contact.');
  });

  it('rejects stale versions (two tabs) with 409', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    expect((await ops.put(`/onboarding/drafts/${d.id}/steps/client`, { version: d.version, data: clientStep('TABS-1') })).status).toBe(200);
    const stale = await ops.put(`/onboarding/drafts/${d.id}/steps/client`, { version: d.version, data: clientStep('TABS-1') });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('urn:psacc:problem:stale-version');
  });

  it('checks the client reference against existing clients at step 1', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    const r = await ops.put(`/onboarding/drafts/${d.id}/steps/client`, { version: d.version, data: clientStep('acct-1040') });
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toEqual({ path: 'company.clientReference', message: 'This reference is already used by CL-00001.' });
  });

  it('enforces step order and provider-specific rules; changing provider clears the PSA configuration', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    const early = await ops.put(`/onboarding/drafts/${d.id}/steps/psa-config`, { version: d.version, data: { displayName: 'X PSA', authMethod: 'api_user', config: { zone: 'webservices1' } } });
    expect(early.status).toBe(409);
    let v = d.version;
    v = (await ops.put(`/onboarding/drafts/${d.id}/steps/psa-provider`, { version: v, data: { providerKey: 'autotask' } })).body.version;
    const wrongAuth = await ops.put(`/onboarding/drafts/${d.id}/steps/psa-config`, { version: v, data: { displayName: 'X PSA', authMethod: 'api_member_keys', config: { zone: 'webservices1' } } });
    expect(wrongAuth.status).toBe(400);
    const insecure = await ops.put(`/onboarding/drafts/${d.id}/steps/psa-config`, { version: v, data: { displayName: 'X PSA', authMethod: 'api_user', config: { zone: 'custom', customZoneUrl: 'http://user:pass@psa.example' } } });
    expect(insecure.status).toBe(400);
    expect(insecure.body.errors[0].path).toBe('config.customZoneUrl');
    const smuggled = await ops.put(`/onboarding/drafts/${d.id}/steps/psa-config`, { version: v, data: { displayName: 'X PSA', authMethod: 'api_user', config: { zone: 'webservices1', secret: 'hunter2' } } });
    expect(smuggled.status).toBe(400);
    const ok = await ops.put(`/onboarding/drafts/${d.id}/steps/psa-config`, { version: v, data: { displayName: 'X PSA', authMethod: 'api_user', config: { zone: 'webservices1' } } });
    expect(ok.body.completedSteps).toEqual(['psa-provider', 'psa-config']);
    const changed = await ops.put(`/onboarding/drafts/${d.id}/steps/psa-provider`, { version: ok.body.version, data: { providerKey: 'connectwise' } });
    expect(changed.body.completedSteps).toEqual(['psa-provider']);
    expect(changed.body.data['psa-config']).toBeUndefined();
  });

  it('validates services and deployment preferences', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    expect((await ops.put(`/onboarding/drafts/${d.id}/steps/services`, { version: d.version, data: { serviceIds: [] } })).status).toBe(400);
    expect((await ops.put(`/onboarding/drafts/${d.id}/steps/services`, { version: d.version, data: { serviceIds: ['00000000-0000-4000-8000-000000000000'] } })).status).toBe(400);
    const mismatch = await ops.put(`/onboarding/drafts/${d.id}/steps/deployment`, { version: d.version, data: { targetEnvironment: 'windows_docker', targetOs: 'linux', targetArch: 'amd64' } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.errors[0].path).toBe('targetOs');
    expect((await ops.put(`/onboarding/drafts/${d.id}/steps/deployment`, { version: d.version, data: { targetEnvironment: 'mainframe', targetOs: 'linux', targetArch: 'amd64' } })).status).toBe(400);
  });

  it('cannot complete until every section is saved', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    const r = await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('client, psa-provider, psa-config, services, deployment');
    expect((await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version })).status).toBe(400); // confirmation required
  });
});

describe('completing an onboarding (Test Client A profile: Autotask; Help Desk + Endpoint Management)', () => {
  it('atomically creates client, contacts, PSA instance, services and a draft deployment', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await saveAll(ops, await newDraft(ops), 'TEST-CLIENT-A');
    const r = await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('completed');
    const res = r.body.result;
    expect(res.clientCode).toMatch(/^CL-\d{5}$/);
    expect(res.psaInstanceCode).toMatch(/^PSA-\d{5}$/);
    expect(res.deploymentCode).toMatch(/^DEP-\d{5}$/);
    expect(res.licenseCode).toMatch(/^LIC-\d{5}$/); // Module 14: the wizard creates the client's first license

    const client = (await ops.get(`/clients/${res.clientId}`)).body;
    expect(client).toMatchObject({ code: res.clientCode, status: 'onboarding', serviceStatus: 'in_progress', clientReference: 'TEST-CLIENT-A', isSynthetic: false });
    expect(client.onboardingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaults to today
    expect(client.primaryContact.fullName).toBe('Pat Primary');
    expect(client.counts).toEqual({ contacts: 2, services: 2, psaInstances: 1, deployments: 1 });

    const psa = (await ops.get(`/clients/${res.clientId}/psa-instances`)).body[0];
    expect(psa).toMatchObject({ providerKey: 'autotask', connectionStatus: 'untested', credentialStatus: 'pending_appliance', lastSuccessfulTestAt: null, apiEndpoint: 'https://webservices5.autotask.net/ATServicesRest' });
    // Help Desk uses the PSA, so it is enabled on the new instance; Endpoint Management is not.
    const inst = (await ops.get(`/psa-instances/${psa.id}`)).body;
    expect(inst.config).toEqual({ zone: 'webservices5' });
    expect(inst.enabledServices.map((s: { key: string }) => s.key)).toEqual(['help_desk']);
    expect(JSON.stringify(psa)).not.toMatch(/password|secret|token/i);

    const svcKeys = (await ops.get(`/clients/${res.clientId}/services`)).body.map((s: { key: string }) => s.key).sort();
    expect(svcKeys).toEqual(['endpoint_management', 'help_desk']);

    const dep = (await ops.get(`/clients/${res.clientId}/deployments`)).body[0];
    expect(dep).toMatchObject({ code: res.deploymentCode, lifecycleState: 'draft', healthState: 'unknown', targetEnvironment: 'linux_docker', targetArch: 'amd64', hostLabel: 'psa-edge-01', enrolledAt: null, lastHeartbeatAt: null });

    const actions = (await ops.get(`/clients/${res.clientId}/activity`)).body.items.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['deployment.created', 'license.created', 'psa_instance.created', 'client.onboarded']);
    // The draft deployment is bound to the wizard's license and is entitled to a package (Module 14).
    const detail = (await ops.get(`/deployments/${res.deploymentId}`)).body;
    expect(detail.licenseDetail).toMatchObject({ id: res.licenseId, code: res.licenseCode, status: 'active' });
    expect(detail.readiness.find((c: { key: string }) => c.key === 'license')).toMatchObject({ ok: true });
  });

  it('is idempotent and locks the draft afterwards', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await saveAll(ops, await newDraft(ops), 'IDEMPOTENT-1');
    const first = await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true });
    const second = await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true });
    expect(second.status).toBe(200);
    expect(second.body.result.clientId).toBe(first.body.result.clientId);
    expect((await ops.get('/clients?q=IDEMPOTENT-1')).body.total).toBe(1);
    const edit = await ops.put(`/onboarding/drafts/${d.id}/steps/client`, { version: first.body.version, data: clientStep('IDEMPOTENT-1') });
    expect(edit.status).toBe(409);
    expect(edit.body.type).toBe('urn:psacc:problem:draft-closed');
  });

  it('two drafts with the same reference: the second completion is refused', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const a = await saveAll(ops, await newDraft(ops), 'RACE-REF-1');
    const b = await saveAll(ops, await newDraft(ops), 'RACE-REF-1');
    expect((await ops.post(`/onboarding/drafts/${a.id}/complete`, { version: a.version, confirm: true })).status).toBe(200);
    const r = await ops.post(`/onboarding/drafts/${b.id}/complete`, { version: b.version, confirm: true });
    expect(r.status).toBe(409);
    expect(r.body.type).toBe('urn:psacc:problem:duplicate-reference');
    // Nothing partial was created by the failed attempt.
    expect((await ops.get('/clients?q=RACE-REF-1')).body.total).toBe(1);
  });

  it('abandoned drafts are kept but cannot be completed', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await saveAll(ops, await newDraft(ops), 'ABANDON-1');
    const ab = await ops.post(`/onboarding/drafts/${d.id}/abandon`);
    expect(ab.body.status).toBe('abandoned');
    expect((await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: ab.body.version, confirm: true })).status).toBe(409);
    expect((await ops.get('/onboarding/drafts?status=abandoned')).body.some((x: { id: string }) => x.id === d.id)).toBe(true);
  });

  it('Test Client B profile (ConnectWise; Help Desk + Security Monitoring) gets independent records', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await saveAll(ops, await newDraft(ops), 'TEST-CLIENT-B', 'connectwise', ['help_desk', 'security_monitoring']);
    const r = await ops.post(`/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true });
    const a = (await ops.get('/clients?q=TEST-CLIENT-A')).body.items[0];
    expect(r.body.result.clientId).not.toBe(a.id);
    const svcB = (await ops.get(`/clients/${r.body.result.clientId}/services`)).body.map((s: { key: string }) => s.key).sort();
    expect(svcB).toEqual(['help_desk', 'security_monitoring']);
    const depA = (await ops.get(`/clients/${a.id}/deployments`)).body[0];
    const depB = (await ops.get(`/clients/${r.body.result.clientId}/deployments`)).body[0];
    expect(depA.id).not.toBe(depB.id);
    expect(depA.code).not.toBe(depB.code);
  });
});

describe('onboarding isolation', () => {
  it('organization B cannot see or use organization A drafts', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const d = await newDraft(ops);
    const b = await signedIn(app, EMAIL.orgB);
    expect((await b.get(`/onboarding/drafts/${d.id}`)).status).toBe(404);
    expect((await b.put(`/onboarding/drafts/${d.id}/steps/client`, { version: d.version, data: clientStep('B-TRY') })).status).toBe(404);
    expect((await b.get('/onboarding/drafts')).body).toEqual([]);
    await asApp(null, async (c) => expect((await c.query('SELECT count(*)::int AS n FROM onboarding_drafts')).rows[0].n).toBe(0));
    const { orgB } = await ids();
    await asApp({ orgId: orgB, scopeAll: true }, async (c) => expect((await c.query('SELECT count(*)::int AS n FROM onboarding_drafts')).rows[0].n).toBe(0));
  });
});
