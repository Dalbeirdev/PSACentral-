/**
 * First development milestone (Module 10), executed against the **containerized Control Plane**
 * (infra/control-plane: PostgreSQL, migrations, API with its agent gateway, web) on the real Docker
 * Engine: two separate client appliances — Test Client A (Autotask; Help Desk + Endpoint Management)
 * and Test Client B (ConnectWise; Help Desk + Security Monitoring) — each with its own PostgreSQL,
 * enrolled through generated packages and shown on one dashboard with live health and the real
 * table inventory. Then: isolation, restart persistence, database-stop degradation and recovery,
 * a Control Plane outage with backfilled history, the data boundary (ticket content never reaches
 * the Control Plane), invalid token and identity, and the backup/restore runbook.
 *
 * Prerequisites: `pnpm cp:setup`, `pnpm cp:build`, `pnpm edge:build`. Run: `pnpm test:milestone`.
 * Set MILESTONE_KEEP=1 to leave the stack and both appliances running (for screenshots); the state
 * is then written to docs/reports/module-10/milestone-state.json for the capture script to clean up.
 * Skipped — and reported as BLOCKED, never as passed — when Docker or the images are missing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyAndCsr, gw } from '../integration/agent-helpers.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = join(ROOT, 'docs', 'reports', 'module-10');
const CP_DIR = join(ROOT, 'infra', 'control-plane');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
const WSL = process.platform === 'win32';
const KEEP = process.env.MILESTONE_KEEP === '1';

const shSync = (cmd: string, timeout = 120_000) => {
  const r = WSL ? spawnSync('wsl', ['--exec', 'bash', '-c', cmd], { encoding: 'utf8', timeout }) : spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}`.trim(), err: `${r.stderr ?? ''}`.trim() };
};
function sh(cmd: string, timeout = 300_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = WSL ? spawn('wsl', ['--exec', 'bash', '-c', cmd]) : spawn('bash', ['-c', cmd]);
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }); });
  });
}
const toUnix = (p: string) => (WSL ? shSync(`wslpath -a '${p}'`).out : p);
const cp = (args: string, timeout?: number) => sh(`cd '${toUnix(CP_DIR)}' && docker compose ${args}`, timeout);
const node = (args: string | string[], timeout = 600_000) => new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn(process.execPath, ['scripts/control-plane.mjs', ...(Array.isArray(args) ? args : [args])], { cwd: ROOT });
  let out = '';
  const t = setTimeout(() => p.kill(), timeout);
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out: out.trim() }); });
});

function envFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(join(CP_DIR, '.env'))) return out;
  for (const line of readFileSync(join(CP_DIR, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
const ENV = envFile();
const WEB = `http://localhost:${ENV.WEB_PORT ?? 3410}`;
const ready = existsSync(join(CP_DIR, '.env')) && shSync(`docker info --format '{{.ServerVersion}}' && docker image inspect psacc/control-plane-api:${VERSION} psacc/control-plane-web:${VERSION} psacc/psa-edge:${VERSION} --format ok`).code === 0;
if (!ready) console.warn('BLOCKED: Docker Engine, infra/control-plane/.env or the Control Plane / edge images are not available; the milestone test is skipped.');

/** Browser-like client for the containerized stack: cookies, Origin and the CSRF header, through the web proxy. */
class Cp {
  cookies = new Map<string, string>();
  async req(method: string, path: string, body?: unknown, raw = false): Promise<{ status: number; body: any; buffer?: Buffer }> {
    const headers: Record<string, string> = { origin: WEB, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['x-csrf-token'] = this.cookies.get('psacc_csrf') ?? '';
    const r = await fetch(`${WEB}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, v] = kv!.split('=');
      this.cookies.set(k!.trim(), v ?? '');
    }
    if (raw) return { status: r.status, body: null, buffer: Buffer.from(await r.arrayBuffer()) };
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  put = (p: string, b: unknown) => this.req('PUT', p, b);
}

type Inst = { label: string; provider: string; serviceKeys: string[]; clientId: string; deploymentId: string; code: string; project: string; dir: string; port: number; enrollment: any };
const inst: Inst[] = [];
const results: Record<string, unknown>[] = [];
let admin: Cp;
let winTmp = '';
const work = `/tmp/psacc-milestone-${process.pid}`;
const dc = (i: Inst, args: string, timeout?: number) => sh(`cd ${i.dir} && docker compose -f compose.yaml ${args}`, timeout);
const ownerSql = (i: Inst, sql: string) => dc(i, `exec -T edge-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_owner_password)" psql -h 127.0.0.1 -U psa_edge_owner -d psa_edge -v ON_ERROR_STOP=1 -qtAX' <<'SQL'\n${sql}\nSQL`);
const record = (check: string, outcome: 'pass' | 'fail', detail: Record<string, unknown> = {}) => results.push({ check, outcome, at: new Date().toISOString(), ...detail });
async function waitFor(fn: () => Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${label}`);
}
const health = async (i: Inst) => (await admin.get(`/deployments/${i.deploymentId}/health`)).body;
const database = async (i: Inst) => (await admin.get(`/deployments/${i.deploymentId}/database`)).body;

async function onboard(label: string, provider: string, serviceKeys: string[], psaConfig: Record<string, unknown>, authMethod: string) {
  const services = (await admin.get('/services')).body as { id: string; key: string }[];
  const d = (await admin.post('/onboarding/drafts')).body;
  let version = d.version as number;
  const ref = label.replace(/\s+/g, '-').toUpperCase();
  const steps: [string, unknown][] = [
    ['client', { company: { legalName: `${label} Ltd`, displayName: label, clientReference: ref, businessType: 'Technology', countryCode: 'US', stateRegion: 'Texas', city: 'Austin', timezone: 'America/Chicago', website: 'https://test-client.example' },
      management: { contractStartDate: '2026-10-01', contractEndDate: '2027-09-30', internalNotes: 'Milestone test client.' },
      contacts: [{ fullName: 'Pat Primary', email: `pat@${ref.toLowerCase()}.example`, roles: ['primary'], phone: '+1 555 0100' }] }],
    ['psa-provider', { providerKey: provider }],
    ['psa-config', { displayName: `${label} — PSA`, authMethod, config: psaConfig }],
    ['services', { serviceIds: services.filter((s) => serviceKeys.includes(s.key)).map((s) => s.id) }],
    ['deployment', { targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64', hostLabel: `${ref.toLowerCase()}-edge-01` }],
  ];
  for (const [step, data] of steps) {
    const r = await admin.put(`/onboarding/drafts/${d.id}/steps/${step}`, { version, data });
    expect(r.status, `${label} ${step}: ${JSON.stringify(r.body)}`).toBe(200);
    version = r.body.version;
  }
  const done = await admin.post(`/onboarding/drafts/${d.id}/complete`, { version, confirm: true });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body.result as { clientId: string; deploymentId: string; deploymentCode: string; psaInstanceCode: string };
}

describe.skipIf(!ready)('first milestone: two client appliances on one containerized Control Plane', () => {
  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    const started = performance.now();
    // Always from a fresh stack: the milestone proves setup → bootstrap → onboarding end to end.
    await node('destroy');
    expect((await node('up')).code, 'control plane up').toBe(0);
    await waitFor(async () => (await fetch(`${WEB}/api/v1/health/live`)).ok, 120_000, 'API behind the web proxy');
    const boot = await node('bootstrap');
    expect(boot.code, boot.out).toBe(0);
    admin = new Cp();
    const login = await admin.post('/auth/login', { email: ENV.BOOTSTRAP_ADMIN_EMAIL, password: ENV.BOOTSTRAP_ADMIN_PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    record('control plane: containers up, migrated, bootstrapped, administrator signed in through the web proxy', 'pass', { seconds: Math.round((performance.now() - started) / 1000) });

    winTmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'psacc-ms-')));
    const specs = [
      { label: 'Test Client A', provider: 'autotask', serviceKeys: ['help_desk', 'endpoint_management'], config: { zone: 'webservices5' }, auth: 'api_user' },
      { label: 'Test Client B', provider: 'connectwise', serviceKeys: ['help_desk', 'security_monitoring'], config: { site: 'na', companyId: 'testclientb' }, auth: 'api_member_keys' },
    ];
    for (const s of specs) {
      const r = await onboard(s.label, s.provider, s.serviceKeys, s.config, s.auth);
      const pkgRes = await admin.post(`/deployments/${r.deploymentId}/packages`, { tokenValidityHours: 4 });
      expect(pkgRes.status, `${s.label} package: ${JSON.stringify(pkgRes.body)}`).toBe(201);
      const pkg = pkgRes.body.currentPackage;
      const zip = await admin.req('POST', `/deployments/${r.deploymentId}/packages/${pkg.id}/download`, undefined, true);
      expect(zip.status).toBe(200);
      const file = join(winTmp, pkg.fileName);
      writeFileSync(file, zip.buffer!);
      const project = `psacc-${r.deploymentCode.toLowerCase()}`;
      const dir = `${work}/${project}-x/${project}`;
      expect((await sh(`mkdir -p ${work}/${project}-x && cd ${work}/${project}-x && unzip -q "${toUnix(file)}"`)).code).toBe(0);
      const enrollment = JSON.parse((await sh(`cat ${dir}/enrollment/enrollment.json`)).out);
      inst.push({ label: s.label, provider: s.provider, serviceKeys: s.serviceKeys, clientId: r.clientId, deploymentId: r.deploymentId, code: r.deploymentCode, project, dir, port: 18000 + (Number(r.deploymentCode.replace(/\D/g, '')) % 1000), enrollment });
    }
    for (const i of inst) {
      expect((await sh(`cd ${i.dir} && cp config/edge.env.template .env && echo EDGE_BACKUP_INITIAL_DELAY_SECONDS=3 >> .env`)).code).toBe(0);
      const r = await sh(`cd ${i.dir} && scripts/install.sh`, 400_000);
      expect(r.code, `${i.code} install: ${r.err || r.out}`).toBe(0);
    }
    for (const i of inst) {
      await waitFor(async () => (await health(i)).lifecycleState === 'verified', 180_000, `${i.code} verified`);
      await waitFor(async () => (await database(i)).inspection?.pendingTables === 0 && (await database(i)).tables.length > 0, 180_000, `${i.code} schema details`);
    }
    record('two appliances installed from generated packages, enrolled, verified and inventoried', 'pass', { seconds: Math.round((performance.now() - started) / 1000), deployments: inst.map((i) => i.code) });
  });

  afterAll(async () => {
    writeFileSync(join(OUT, 'milestone-results.json'), JSON.stringify({ version: VERSION, finishedAt: new Date().toISOString(), keep: KEEP, results }, null, 2));
    if (KEEP) {
      writeFileSync(join(OUT, 'milestone-state.json'), JSON.stringify({ work, winTmp, web: WEB, deployments: inst.map(({ label, provider, clientId, deploymentId, code, project, dir, port }) => ({ label, provider, clientId, deploymentId, code, project, dir, port })) }, null, 2));
      return;
    }
    for (const i of inst) await dc(i, 'down --volumes --remove-orphans', 180_000);
    await sh(`rm -rf ${work}`);
    if (winTmp) rmSync(winTmp, { recursive: true, force: true });
    await node('destroy');
  });

  it('one dashboard shows both clients with different PSA providers, independent databases and live health', async () => {
    const summary = (await admin.get('/dashboard/summary')).body;
    expect(summary.kpis.totalClients).toBe(2);
    const fleet = (await admin.get('/monitoring/fleet?live=1')).body;
    expect(fleet.rows.map((r: { code: string; healthState: string }) => [r.code, r.healthState])).toEqual(inst.map((i) => [i.code, 'healthy']));
    expect(fleet.syntheticSummary.healthy).toBe(0); // no synthetic data in the containerized stack
    const explorer = (await admin.get('/database-explorer')).body;
    expect(explorer.summary).toMatchObject({ live: 2, synthetic: 0, available: 2 });
    const providers = new Set<string>();
    for (const i of inst) {
      const d = await database(i);
      expect(d.database, i.code).toMatchObject({ databaseName: 'psa_edge', available: true, tableCount: 14 });
      expect(d.inspection.detailedTables).toBe(13);
      const dep = (await admin.get(`/deployments/${i.deploymentId}`)).body;
      providers.add(dep.psaInstanceDetail.providerKey);
      expect(dep.services.filter((s: { enabledOnPsa: boolean; requiresPsa: boolean }) => !s.requiresPsa || s.enabledOnPsa).map((s: { key: string }) => s.key).sort()).toEqual([...i.serviceKeys].sort());
      // Own PostgreSQL container and volume per appliance.
      expect((await sh(`docker ps --format '{{.Names}}' | grep -c '^${i.project}-edge-postgres-1$'`)).out).toBe('1');
      expect((await sh(`docker volume ls -q | grep -c '^${i.project}_pgdata$'`)).out).toBe('1');
    }
    expect([...providers].sort()).toEqual(['autotask', 'connectwise']);
    // Each appliance holds its own identity and its own PSA; the credentials directories differ.
    const ids = await Promise.all(inst.map((i) => ownerSql(i, `SELECT value FROM app_metadata WHERE key = 'installation.id'`)));
    expect(ids.every((r) => /^[0-9a-f-]{36}$/.test(r.out)), JSON.stringify(ids.map((r) => r.out))).toBe(true);
    expect(new Set(ids.map((r) => r.out)).size).toBe(2);
    const secrets = await Promise.all(inst.map((i) => sh(`cat ${i.dir}/secrets/app_db_password`)));
    expect(secrets.every((r) => r.out.length >= 32)).toBe(true);
    expect(secrets[0]!.out).not.toBe(secrets[1]!.out);
    record('isolation: two clients, two PSA providers, own PostgreSQL container, volume, identity and credentials each', 'pass', { providers: [...providers] });
  });

  it('data boundary: ticket content on an appliance never reaches the Control Plane, only counts do', async () => {
    const a = inst[0]!;
    const marker = `MILESTONE-SECRET-${Date.now()}`;
    expect((await ownerSql(a, `INSERT INTO helpdesk_tickets (title, description, status, priority) VALUES ('${marker} title', '${marker} body with a credential-looking value hunter2', 'open', 'high')`)).code).toBe(0);
    await waitFor(async () => (await health(a)).latest?.ticket_processing_metrics?.payload?.ticketsTotal >= 1, 120_000, 'ticket count reported');
    const h = await health(a);
    expect(h.latest.ticket_processing_metrics.payload).toMatchObject({ ticketsTotal: 1, ticketsOpen: 1 });
    const dump = await cp(`exec -T postgres pg_dump -U postgres --data-only psacc`);
    expect(dump.code).toBe(0);
    expect(dump.out).not.toContain(marker);
    expect(dump.out).not.toContain('hunter2');
    expect(dump.out).not.toMatch(/psacc_enr_[A-Za-z0-9_-]{20,}/); // enrollment tokens are stored hashed
    expect(dump.out).not.toContain('BEGIN PRIVATE KEY'); // agent keys never leave the appliance; the CA key is encrypted
    const tables = (await database(a)).tables.map((t: { name: string }) => t.name);
    expect(tables).toContain('helpdesk_tickets');
    expect(JSON.stringify(await admin.get(`/deployments/${a.deploymentId}/database/tables/public/helpdesk_tickets`))).not.toContain(marker);
    record('data boundary: ticket text absent from a full Control Plane dump; ticket count 1 reported', 'pass', { dumpBytes: dump.out.length });
  });

  it('invalid token and identity are refused by the containerized gateway', async () => {
    const a = inst[0]!;
    const k = await keyAndCsr(a.enrollment.installationId);
    const url = new URL(ENV.AGENT_GATEWAY_URL!);
    const call = (body: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      import('node:https').then(({ request }) => {
        const req = request({ host: url.hostname, port: Number(url.port), path: '/agent/v1/enroll', method: 'POST', ca: a.enrollment.caCertificate, headers: { 'content-type': 'application/json' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
      });
    });
    const replay = await call({ token: a.enrollment.token, deploymentId: a.enrollment.deploymentId, installationId: a.enrollment.installationId, csr: k.csr, agentVersion: '0.1.0' });
    expect([401, 403, 409]).toContain(replay.status);
    const wrongIdentity = await call({ token: a.enrollment.token, deploymentId: inst[1]!.enrollment.deploymentId, installationId: a.enrollment.installationId, csr: k.csr, agentVersion: '0.1.0' });
    expect([401, 403, 409]).toContain(wrongIdentity.status);
    const fake = await call({ token: 'psacc_enr_' + 'x'.repeat(43), deploymentId: a.enrollment.deploymentId, installationId: a.enrollment.installationId, csr: k.csr, agentVersion: '0.1.0' });
    expect([400, 401, 403]).toContain(fake.status);
    expect((await gw(Number(url.port), '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.enrollment.caCertificate).catch((e: Error) => ({ status: 0, body: { error: e.message } }))).status).not.toBe(200); // no client certificate
    record('invalid token / identity: used token replayed, token for another deployment, fabricated token, no certificate — all refused', 'pass', { statuses: [replay.body.error, wrongIdentity.body.error, fake.body.error] });
  });

  it('database stop degrades the deployment to critical from real checks and recovers', async () => {
    const b = inst[1]!;
    await dc(b, 'stop edge-postgres', 120_000);
    await waitFor(async () => (await health(b)).healthState === 'critical', 120_000, `${b.code} critical`);
    expect((await health(b)).findings.map((f: { code: string }) => f.code)).toContain('database_unavailable');
    await dc(b, 'start edge-postgres', 120_000);
    await waitFor(async () => (await health(b)).healthState === 'healthy', 150_000, `${b.code} healthy again`);
    const states = (await health(b)).events.map((e: { healthState: string }) => e.healthState);
    expect(states).toContain('critical');
    record('database stop → critical (database_unavailable) → start → healthy', 'pass', { timeline: states.reverse() });
  });

  it('restart persistence: an appliance keeps its identity, data and certificate across down/up', async () => {
    const a = inst[0]!;
    const before = (await admin.get(`/deployments/${a.deploymentId}`)).body.agentCertificates.find((c: { status: string }) => c.status === 'active').serial;
    await dc(a, 'down', 180_000); // volumes kept
    await dc(a, 'up -d', 240_000);
    await waitFor(async () => (await dc(a, 'ps --format "{{.Service}} {{.Health}}"')).out.includes('edge-api healthy'), 150_000, `${a.code} up`);
    await waitFor(async () => (await health(a)).healthState === 'healthy', 150_000, `${a.code} healthy after restart`);
    const after = (await admin.get(`/deployments/${a.deploymentId}`)).body.agentCertificates.find((c: { status: string }) => c.status === 'active').serial;
    expect(after).toBe(before);
    expect((await ownerSql(a, 'SELECT count(*) FROM helpdesk_tickets')).out).toBe('1');
    record('restart persistence: same certificate serial, ticket row survived, healthy again', 'pass', { serial: `${before.slice(0, 12)}…` });
  });

  it('Control Plane outage: appliances keep working and the history backfills when it returns', async () => {
    const a = inst[0]!;
    const outageStart = new Date();
    expect((await cp('stop api', 120_000)).code).toBe(0);
    await new Promise((r) => setTimeout(r, 50_000));
    // During the outage the appliance is fully functional locally.
    const local = await sh(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${a.port}/healthz`);
    expect(local.out).toBe('200');
    const status = JSON.parse((await dc(a, 'exec -T edge-agent edge-agent status')).out);
    expect(status.enrolled).toBe(true);
    expect(status.bufferedReports).toBeGreaterThan(0);
    const outageEnd = new Date();
    expect((await cp('up -d --wait api web', 240_000)).code).toBe(0);
    await waitFor(async () => (await fetch(`${WEB}/api/v1/health/live`)).ok, 120_000, 'API back');
    await waitFor(async () => (await health(a)).healthState === 'healthy', 150_000, `${a.code} healthy after outage`);
    // The buffered batches arrive with their original observation times in the cycles after reconnection.
    const samplesInWindow = async () => ((await health(a)).resourceHistory as { observedAt: string }[]).filter((s) => new Date(s.observedAt) >= outageStart && new Date(s.observedAt) <= outageEnd).length;
    await waitFor(async () => (await samplesInWindow()) >= 2, 90_000, 'history backfilled from the outbox');
    const inWindow = await samplesInWindow();
    expect(inWindow, 'resource samples observed during the outage').toBeGreaterThanOrEqual(2);
    record('control plane outage: local admin served, reports buffered, history backfilled after recovery', 'pass', { outageSeconds: Math.round((outageEnd.getTime() - outageStart.getTime()) / 1000), backfilledSamples: inWindow, buffered: status.bufferedReports });
  });

  it('backup and restore runbook: a client created after the backup disappears, both appliances stay healthy', async () => {
    const backup = await node('backup');
    expect(backup.code, backup.out).toBe(0);
    const file = /backup written: (\S+)/.exec(backup.out)?.[1];
    expect(file).toBeTruthy();
    const extra = await onboard('Test Client C', 'halopsa', ['help_desk'], { tenantUrl: 'https://c.halopsa.example' }, 'oauth2_client_credentials');
    expect((await admin.get('/dashboard/summary')).body.kpis.totalClients).toBe(3);
    const restore = await node(['restore', join(ROOT, file!)], 600_000);
    expect(restore.code, restore.out).toBe(0);
    await waitFor(async () => (await fetch(`${WEB}/api/v1/health/live`)).ok, 120_000, 'API after restore');
    admin = new Cp(); // sessions were part of the restored state
    expect((await admin.post('/auth/login', { email: ENV.BOOTSTRAP_ADMIN_EMAIL, password: ENV.BOOTSTRAP_ADMIN_PASSWORD })).status).toBe(200);
    expect((await admin.get('/dashboard/summary')).body.kpis.totalClients).toBe(2);
    expect((await admin.get(`/deployments/${extra.deploymentId}`)).status).toBe(404);
    for (const i of inst) await waitFor(async () => (await health(i)).healthState === 'healthy', 150_000, `${i.code} healthy after restore`);
    record('backup/restore: checksum verified, database recreated, client C gone, both appliances healthy', 'pass', { file: file!.replace(/\\/g, '/') });
  });
});
