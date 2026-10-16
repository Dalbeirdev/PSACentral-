// Module 4 evidence: captures the Service Catalog pages against the dev stack (synthetic organization),
// after creating one real catalog entry through the API ("Dark Web Monitoring" with a required setting)
// and assigning it to a client with its settings. Leaves the dev database as it was (reseed with
// `pnpm db:seed -- --reset` afterwards). Usage: node scripts/screenshots-m4.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://localhost:3210';
const shots = fileURLToPath(new URL('../../../docs/reports/module-04/screenshots/', import.meta.url));
mkdirSync(shots, { recursive: true });
const env = Object.fromEntries(readFileSync(new URL('../../api/.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

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
const shot = async (name, full = true) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}${name}.png`, fullPage: full });
  console.log('saved', name);
};

try {
  const cats = await api('GET', '/service-categories');
  const security = cats.find((c) => c.key === 'security');
  let svc = (await api('GET', '/services?q=dark_web'))[0];
  if (!svc) {
    svc = await api('POST', '/services', {
      key: 'dark_web_monitoring', name: 'Dark Web Monitoring', description: 'Credential exposure monitoring with PSA ticket escalation.', categoryId: security.id,
      requiresPsa: true, integrationDependencies: ['psa.tickets', 'edr'], sortOrder: 125,
      configRequirements: [
        { key: 'monitoredDomains', label: 'Monitored domains', type: 'text', required: true, description: 'Comma-separated domains to watch.' },
        { key: 'alertSeverity', label: 'Alert severity', type: 'select', required: false, options: [{ value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' }] },
      ],
    });
  }
  const client = (await api('GET', '/clients?q=Bluepeak')).items[0];
  const current = await api('GET', `/clients/${client.id}/services`);
  if (!current.some((s) => s.id === svc.id)) {
    await api('PUT', `/clients/${client.id}/services`, { serviceIds: [...current.map((s) => s.id), svc.id], config: { [svc.id]: { monitoredDomains: 'bluepeak.example, bluepeak.test', alertSeverity: 'critical' } } });
  }
  const helpDesk = (await api('GET', '/services?q=help_desk'))[0];

  await page.goto(`${base}/services`, { waitUntil: 'networkidle' });
  await shot('01-catalog');
  await page.goto(`${base}/services?category=security`, { waitUntil: 'networkidle' });
  await shot('02-catalog-filtered-security', false);
  await page.goto(`${base}/services/${helpDesk.id}`, { waitUntil: 'networkidle' });
  await shot('03-service-help-desk-detail');
  await page.goto(`${base}/services/${svc.id}`, { waitUntil: 'networkidle' });
  await shot('04-service-dark-web-detail');
  await page.goto(`${base}/services/${svc.id}/edit`, { waitUntil: 'networkidle' });
  await shot('05-service-edit-form');
  await page.goto(`${base}/services/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('Service name').fill('Dark Web Monitoring');
  await page.getByRole('button', { name: 'Create service' }).click();
  await page.getByText('Some fields need attention.').waitFor();
  await shot('06-service-new-validation', false);
  await page.goto(`${base}/services/categories`, { waitUntil: 'networkidle' });
  await shot('07-categories');
  await page.goto(`${base}/clients/${client.id}/services`, { waitUntil: 'networkidle' });
  await shot('08-client-services-with-settings');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${base}/services`, { waitUntil: 'networkidle' });
  await shot('09-catalog-mobile', false);
  await page.goto(`${base}/services/${svc.id}`, { waitUntil: 'networkidle' });
  await shot('10-service-detail-mobile', false);
} finally {
  await browser.close();
}
