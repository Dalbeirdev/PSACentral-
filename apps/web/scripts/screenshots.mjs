// Captures reference screenshots of the running dev stack (web :3210, api :4210) into
// docs/reports/module-01/screenshots. Usage: node scripts/screenshots.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://localhost:3210';
const out = fileURLToPath(new URL('../../../docs/reports/module-01/screenshots/', import.meta.url));
mkdirSync(out, { recursive: true });
const env = Object.fromEntries(
  readFileSync(new URL('../../api/.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const browser = await chromium.launch({ channel: 'msedge' });
async function session(viewport, email = 'avery.admin@psacc.test') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const r = await page.request.post(`${base}/api/v1/auth/login`, { data: { email, password: env.SEED_DEFAULT_PASSWORD }, headers: { origin: base } });
  if (r.status() !== 200) throw new Error(`login failed ${r.status()}`);
  return { ctx, page };
}
async function shot(page, path, name, { full = true } = {}) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}${name}.png`, fullPage: full });
  console.log('saved', name);
}

{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await shot(page, '/login', '01-login-desktop', { full: false });
  await ctx.close();
}
{
  const { ctx, page } = await session({ width: 1440, height: 900 });
  await shot(page, '/dashboard', '02-dashboard-desktop');
  await shot(page, '/audit', '03-audit-desktop');
  await shot(page, '/settings/users', '04-users-desktop');
  await shot(page, '/settings/roles', '05-roles-desktop');
  await shot(page, '/settings/security', '06-security-desktop', { full: false });
  await shot(page, '/deployments', '07-planned-module-desktop', { full: false });
  await shot(page, '/settings', '08-settings-status-desktop');
  await ctx.close();
}
{
  const { ctx, page } = await session({ width: 390, height: 844 });
  await shot(page, '/dashboard', '09-dashboard-mobile');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.screenshot({ path: `${out}10-mobile-nav-open.png` });
  console.log('saved 10-mobile-nav-open');
  await ctx.close();
}
{
  const { ctx, page } = await session({ width: 1440, height: 900 }, 'riley.technician@psacc.test');
  await shot(page, '/dashboard', '11-dashboard-technician-scope', { full: false });
  await ctx.close();
}
await browser.close();
