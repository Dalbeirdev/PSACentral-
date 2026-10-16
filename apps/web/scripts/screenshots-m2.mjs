// Module 2 reference screenshots from the running dev stack (web :3210, api :4210).
// Walks the onboarding wizard through the API so each step can be captured. Usage: node scripts/screenshots-m2.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://localhost:3210';
const out = fileURLToPath(new URL('../../../docs/reports/module-02/screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });
const env = Object.fromEntries(
  readFileSync(new URL('../../api/.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const login = await page.request.post(`${base}/api/v1/auth/login`, { data: { email: 'jordan.ops@psacc.test', password: env.SEED_DEFAULT_PASSWORD }, headers: { origin: base } });
if (login.status() !== 200) throw new Error(`login ${login.status()}`);
const csrf = async () => ({ origin: base, 'x-csrf-token': (await ctx.cookies()).find((c) => c.name === 'psacc_csrf').value });
const api = async (method, path, data) => {
  const r = await page.request.fetch(`${base}/api/v1${path}`, { method, data, headers: await csrf() });
  if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`);
  return r.json();
};
async function shot(path, name, { full = false, before } = {}) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  if (before) await before();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}${name}.png`, fullPage: full });
  console.log('saved', name);
}

await shot('/clients', '01-client-directory', { full: true });
const bluepeak = (await api('GET', '/clients?q=Bluepeak')).items[0].id;
await shot(`/clients/${bluepeak}`, '02-client-overview', { full: true });
await shot(`/clients/${bluepeak}/contacts`, '03-client-contacts');
await shot(`/clients/${bluepeak}/services`, '04-client-services', { full: true });
await shot(`/clients/${bluepeak}/health`, '05-client-health');
await shot(`/clients/${bluepeak}/edit`, '06-client-edit', { full: true });

// Wizard: create a draft and capture each step as it is filled (synthetic demo data, abandoned afterwards).
const services = await api('GET', '/services');
const users = await api('GET', '/directory/users');
let d = await api('POST', '/onboarding/drafts');
await shot('/clients/new', '07-onboarding-start');
await shot(`/clients/new/${d.id}/client`, '08-wizard-step1-client', { full: true });
const save = async (step, data) => (d = await api('PUT', `/onboarding/drafts/${d.id}/steps/${step}`, { version: d.version, data }));
await save('client', {
  company: { legalName: 'Northwind Demo Holdings LLC', displayName: 'Northwind Demo', clientReference: 'DEMO-SHOT-1', businessType: 'Technology', countryCode: 'US', stateRegion: 'Washington', city: 'Seattle', timezone: 'America/Los_Angeles', website: 'https://northwind-demo.example' },
  management: { accountManagerUserId: users.find((u) => u.displayName === 'Jordan Ellis').id, contractStartDate: '2026-11-01', contractEndDate: '2029-10-31' },
  contacts: [{ fullName: 'Avery Demo', email: 'avery@northwind-demo.example', roles: ['primary'] }, { fullName: 'Blake Demo', email: 'blake@northwind-demo.example', roles: ['technical'] }],
});
await shot(`/clients/new/${d.id}/psa-provider`, '09-wizard-step2-provider', { before: () => page.getByText('Autotask PSA', { exact: true }).click() });
await save('psa-provider', { providerKey: 'autotask' });
await shot(`/clients/new/${d.id}/psa-config`, '10-wizard-step3-psa-config');
await save('psa-config', { displayName: 'Northwind Demo — Autotask', authMethod: 'api_user', config: { zone: 'webservices5' } });
await shot(`/clients/new/${d.id}/services`, '11-wizard-step4-services', { full: true });
await save('services', { serviceIds: services.filter((s) => ['help_desk', 'endpoint_management'].includes(s.key)).map((s) => s.id) });
await shot(`/clients/new/${d.id}/deployment`, '12-wizard-step5-deployment', { before: () => page.getByText('Linux Docker host', { exact: true }).click() });
await save('deployment', { targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'nw-edge-01' });
await shot(`/clients/new/${d.id}/review`, '13-wizard-step6-review', { full: true });
await shot(`/clients/new/${d.id}/create`, '14-wizard-step7-create', { full: true });
await api('POST', `/onboarding/drafts/${d.id}/abandon`);

// Mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mp = await m.newPage();
await mp.request.post(`${base}/api/v1/auth/login`, { data: { email: 'jordan.ops@psacc.test', password: env.SEED_DEFAULT_PASSWORD }, headers: { origin: base } });
await mp.goto(`${base}/clients/${bluepeak}`, { waitUntil: 'networkidle' });
await mp.screenshot({ path: `${out}15-client-overview-mobile.png`, fullPage: true });
console.log('saved 15-client-overview-mobile');
await browser.close();
