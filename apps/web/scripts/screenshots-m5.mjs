// Module 5 reference screenshots from the running dev stack (web :3210, api :4210).
// Creates real (non-synthetic) demo records in the dev database through the API; reseed afterwards
// (`npx tsx --env-file=.env src/database/cli.ts seed --reset` in apps/api). Usage: node scripts/screenshots-m5.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://localhost:3210';
const out = fileURLToPath(new URL('../../../docs/reports/module-05/screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });
const env = Object.fromEntries(
  readFileSync(new URL('../../api/.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const browser = await chromium.launch({ channel: 'msedge' });
async function session(email, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const login = await page.request.post(`${base}/api/v1/auth/login`, { data: { email, password: env.SEED_DEFAULT_PASSWORD }, headers: { origin: base } });
  if (login.status() !== 200) throw new Error(`login ${login.status()}`);
  const csrf = async () => ({ origin: base, 'x-csrf-token': (await ctx.cookies()).find((c) => c.name === 'psacc_csrf').value });
  const api = async (method, path, data) => {
    const r = await page.request.fetch(`${base}/api/v1${path}`, { method, data, headers: await csrf() });
    if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`);
    return (r.headers()['content-type'] ?? '').includes('json') ? r.json() : r.body();
  };
  const shot = async (path, name, { full = false, before } = {}) => {
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    if (before) await before(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }); // dev-server badge only
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${out}${name}.png`, fullPage: full });
    console.log('saved', name);
  };
  return { page, api, shot };
}

const ops = await session('jordan.ops@psacc.test');
await ops.shot('/deployments', '01-deployments-list', { full: true });
const lumen = (await ops.api('GET', '/clients?q=Lumen')).items[0];
await ops.shot(`/deployments/new?clientId=${lumen.id}`, '02-new-deployment', {
  full: true,
  before: async (p) => {
    await p.getByText('Linux Docker host', { exact: true }).click();
    await p.getByLabel('Host label').fill('lumen-edge-01');
  },
});
const psa = (await ops.api('GET', `/psa-instances?clientId=${lumen.id}&status=active`)).items[0];
const dep = await ops.api('POST', '/deployments', { clientId: lumen.id, psaInstanceId: psa.id, targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'lumen-edge-01' });
await ops.shot(`/deployments/${dep.id}?saved=created`, '03-deployment-created-draft', { full: true });
await ops.shot(`/deployments/${dep.id}/installation`, '04-installation-ready', { full: true });
await ops.api('POST', `/deployments/${dep.id}/packages`, { tokenValidityHours: 24 });
await ops.shot(`/deployments/${dep.id}/installation`, '05-package-generated', {
  full: true,
  before: async (p) => { await p.getByText(/Package contents/).click(); },
});
const d1 = await ops.api('GET', `/deployments/${dep.id}`);
await ops.api('POST', `/deployments/${dep.id}/packages/${d1.currentPackage.id}/download`);
await ops.shot(`/deployments/${dep.id}`, '06-overview-downloaded-not-installed', { full: true });
await ops.shot(`/deployments/${dep.id}/installation`, '07-replace-confirmation', {
  before: async (p) => {
    await p.getByRole('button', { name: 'Generate a new package' }).click();
    await p.getByRole('group', { name: 'Replace package' }).scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  },
});
await ops.page.screenshot({ path: `${out}07-replace-confirmation.png` });
await ops.shot(`/deployments/${dep.id}/installation`, '08-revoke-inline', {
  before: async (p) => {
    await p.getByRole('button', { name: 'Revoke' }).click();
    await p.getByLabel('Reason').fill('Sent to the wrong contact');
  },
});
await ops.page.getByRole('group', { name: 'Revoke package' }).scrollIntoViewIfNeeded();
await ops.page.screenshot({ path: `${out}08-revoke-inline.png` });
await ops.api('POST', `/deployments/${dep.id}/packages`, { tokenValidityHours: 4, replaceExisting: true });
await ops.shot(`/deployments/${dep.id}/installation`, '09-history-and-instructions', {
  full: true,
});
await ops.shot(`/deployments/${dep.id}/settings`, '10-settings-locked');
await ops.shot(`/deployments/${dep.id}/health`, '11-health-pending-reports');
const synthetic = (await ops.api('GET', '/deployments?q=DEP-00002')).items[0];
await ops.shot(`/deployments/${synthetic.id}/installation`, '12-synthetic-not-ready');

// Onboarding step 8 with a generated, downloaded package.
let d = await ops.api('POST', '/onboarding/drafts');
const users = await ops.api('GET', '/directory/users');
const services = await ops.api('GET', '/services');
const save = async (step, data) => (d = await ops.api('PUT', `/onboarding/drafts/${d.id}/steps/${step}`, { version: d.version, data }));
await save('client', {
  company: { legalName: 'Northwind Demo Holdings LLC', displayName: 'Northwind Demo', clientReference: 'DEMO-SHOT-5', businessType: 'Technology', countryCode: 'US', stateRegion: 'Washington', city: 'Seattle', timezone: 'America/Los_Angeles', website: '' },
  management: { accountManagerUserId: users.find((u) => u.displayName === 'Jordan Ellis').id },
  contacts: [{ fullName: 'Avery Demo', email: 'avery@northwind-demo.example', roles: ['primary'] }],
});
await save('psa-provider', { providerKey: 'autotask' });
await save('psa-config', { displayName: 'Northwind Demo — Autotask', authMethod: 'api_user', config: { zone: 'webservices5' } });
await save('services', { serviceIds: services.filter((s) => ['help_desk', 'endpoint_management'].includes(s.key)).map((s) => s.id) });
await save('deployment', { targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'nw-edge-01' });
d = await ops.api('POST', `/onboarding/drafts/${d.id}/complete`, { version: d.version, confirm: true });
await ops.shot(`/clients/new/${d.id}/download`, '13-wizard-step8-generate', { full: true });
await ops.api('POST', `/deployments/${d.result.deploymentId}/packages`, { tokenValidityHours: 24 });
await ops.shot(`/clients/new/${d.id}/download`, '14-wizard-step8-package', { full: true });

const viewer = await session('quinn.viewer@psacc.test');
await viewer.shot(`/deployments/${dep.id}/installation`, '15-installation-read-only', { full: true });
const mobile = await session('jordan.ops@psacc.test', { width: 390, height: 844 });
await mobile.shot(`/deployments/${dep.id}/installation`, '16-installation-mobile', { full: true });
await browser.close();
