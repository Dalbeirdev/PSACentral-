// Module 3 reference screenshots from the running dev stack (web :3210, api :4210).
// Read-only against the seeded data: forms are filled but never submitted. Usage: node scripts/screenshots-m3.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://localhost:3210';
const out = fileURLToPath(new URL('../../../docs/reports/module-03/screenshots/', import.meta.url));
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
    return r.json();
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
await ops.shot('/psa', '01-psa-list', { full: true });
await ops.shot('/psa?provider=servicenow', '02-psa-list-filtered');
const meridian = (await ops.api('GET', '/psa-instances?q=Meridian')).items;
const sn = meridian.find((i) => i.providerKey === 'servicenow');
await ops.shot(`/psa/${sn.id}`, '03-psa-detail', { full: true });
await ops.shot(`/psa/${sn.id}`, '04-deployment-move-confirmation', {
  full: true,
  before: async (p) => {
    await p.getByRole('button', { name: 'Use this instance' }).first().click();
    await p.getByRole('button', { name: 'Yes, move' }).scrollIntoViewIfNeeded();
  },
});
await ops.shot(`/psa/${sn.id}/configure`, '05-psa-configure-servicenow', { full: true });

const lumen = (await ops.api('GET', '/clients?q=Lumen')).items[0];
await ops.shot(`/clients/${lumen.id}/psa`, '06-client-psa-tab');
await ops.shot('/psa/new', '07-psa-new-empty', { full: true });
await ops.shot(`/psa/new?clientId=${lumen.id}`, '08-psa-new-connectwise-validation', {
  full: true,
  before: async (p) => {
    await p.getByText('ConnectWise PSA', { exact: true }).click();
    await p.getByLabel('Site').selectOption('onprem');
    await p.getByLabel('Company ID').fill('bad id!');
    await p.getByRole('button', { name: 'Create PSA instance' }).click();
    await p.getByText('Server host name is required.').waitFor();
  },
});
await ops.shot(`/psa/new?clientId=${lumen.id}`, '09-psa-new-connectwise-endpoint-preview', {
  full: true,
  before: async (p) => {
    await p.getByText('ConnectWise PSA', { exact: true }).click();
    await p.getByLabel('Site').selectOption('onprem');
    await p.getByLabel('Company ID').fill('lumenpeds');
    await p.getByLabel('Server host name').fill('psa.lumen.example');
    await p.getByTestId('endpoint-preview').getByText('https://psa.lumen.example/v4_6_release/apis/3.0').waitFor();
  },
});

// Onboarding step 3 now renders the provider's adapter fields (draft abandoned afterwards).
let d = await ops.api('POST', '/onboarding/drafts');
const users = await ops.api('GET', '/directory/users');
d = await ops.api('PUT', `/onboarding/drafts/${d.id}/steps/client`, {
  version: d.version,
  data: {
    company: { legalName: 'Northwind Demo Holdings LLC', displayName: 'Northwind Demo', clientReference: 'DEMO-SHOT-3', businessType: 'Technology', countryCode: 'US', stateRegion: 'Washington', city: 'Seattle', timezone: 'America/Los_Angeles', website: '' },
    management: { accountManagerUserId: users.find((u) => u.displayName === 'Jordan Ellis').id },
    contacts: [{ fullName: 'Avery Demo', email: 'avery@northwind-demo.example', roles: ['primary'] }],
  },
});
d = await ops.api('PUT', `/onboarding/drafts/${d.id}/steps/psa-provider`, { version: d.version, data: { providerKey: 'autotask' } });
await ops.shot(`/clients/new/${d.id}/psa-config`, '10-wizard-step3-autotask-fields', {
  full: true,
  before: async (p) => {
    await p.getByLabel('Web services zone').selectOption('webservices5');
    await p.getByTestId('endpoint-preview').getByText('https://webservices5.autotask.net/ATServicesRest').waitFor();
  },
});
await ops.api('POST', `/onboarding/drafts/${d.id}/abandon`);

const viewer = await session('quinn.viewer@psacc.test');
await viewer.shot(`/psa/${sn.id}`, '11-psa-detail-read-only', { full: true });

const mobile = await session('jordan.ops@psacc.test', { width: 390, height: 844 });
await mobile.shot(`/psa/${sn.id}`, '12-psa-detail-mobile', { full: true });
await browser.close();
