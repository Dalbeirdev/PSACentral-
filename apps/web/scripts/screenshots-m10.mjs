// Module 10 evidence: captures the milestone dashboard from the containerized Control Plane while the
// two client appliances installed by `MILESTONE_KEEP=1 pnpm test:milestone` are still running, then
// removes the appliances and the Control Plane stack. Usage: node scripts/screenshots-m10.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = `${root}docs/reports/module-10/`;
const shots = `${outDir}screenshots/`;
mkdirSync(shots, { recursive: true });
const stateFile = `${outDir}milestone-state.json`;
if (!existsSync(stateFile)) throw new Error('milestone-state.json missing: run MILESTONE_KEEP=1 pnpm test:milestone first');
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const env = Object.fromEntries(readFileSync(`${root}infra/control-plane/.env`, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const base = state.web;
const sh = (cmd, timeout = 400_000) => spawnSync('wsl', ['--exec', 'bash', '-c', cmd], { encoding: 'utf8', timeout });

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const shot = async (name, full = true) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}${name}.png`, fullPage: full });
  console.log('saved', name);
};

try {
  const login = await page.request.post(`${base}/api/v1/auth/login`, { data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }, headers: { origin: base } });
  if (login.status() !== 200) throw new Error(`login ${login.status()}`);
  await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  await shot('01-dashboard-two-clients');
  await page.goto(`${base}/clients`, { waitUntil: 'networkidle' });
  await shot('02-clients', false);
  await page.goto(`${base}/deployments`, { waitUntil: 'networkidle' });
  await shot('03-deployments', false);
  await page.goto(`${base}/monitoring`, { waitUntil: 'networkidle' });
  await shot('04-health-monitoring-live');
  await page.goto(`${base}/database-explorer`, { waitUntil: 'networkidle' });
  await shot('05-database-explorer-two-databases');
  for (const [n, d] of state.deployments.entries()) {
    const tag = n === 0 ? 'a' : 'b';
    await page.goto(`${base}/deployments/${d.deploymentId}`, { waitUntil: 'networkidle' });
    await shot(`06${tag}-deployment-${tag}-overview`);
    await page.goto(`${base}/deployments/${d.deploymentId}/health`, { waitUntil: 'networkidle' });
    await shot(`07${tag}-deployment-${tag}-health`);
    await page.goto(`${base}/deployments/${d.deploymentId}/database`, { waitUntil: 'networkidle' });
    await shot(`08${tag}-deployment-${tag}-database`);
  }
  await page.goto(`${base}/audit`, { waitUntil: 'networkidle' });
  await shot('09-audit-log', false);
  const ps = sh(`docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | grep -E '^psacc-(cp|dep)' | sort`);
  const vols = sh(`docker volume ls --format '{{.Name}}' | grep -E '^psacc-(cp|dep)' | sort`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${outDir}milestone-containers.txt`, `$ docker ps (Control Plane stack + two client appliances)\n${ps.stdout}\n$ docker volume ls\n${vols.stdout}\n`);
} finally {
  await browser.close();
  for (const d of state.deployments) sh(`cd ${d.dir} && docker compose -f compose.yaml down --volumes --remove-orphans`);
  sh(`rm -rf ${state.work}`);
  if (state.winTmp) rmSync(state.winTmp, { recursive: true, force: true });
  spawnSync(process.execPath, ['scripts/control-plane.mjs', 'destroy'], { cwd: root, stdio: 'inherit' });
  unlinkSync(stateFile);
}
