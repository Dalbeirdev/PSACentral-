/**
 * Real Docker installation of two client appliances, enrolled with the Control Plane (Modules 6–7).
 *
 * Packages for an Autotask client (Test Client A) and a ConnectWise client (Test Client B) are
 * generated through the API and installed side by side with their own install.sh, using the locally
 * built standard image psacc/psa-edge:<version>. The agent gateway runs in this test process on the
 * host's address; each agent dials out to it, enrolls with its single-use token and then talks over
 * mutual TLS. On the real engine the test checks: idempotent database initialization, least-privilege
 * roles, the local admin UI and encrypted credentials, enrollment and heartbeats, certificate
 * renewal, a Control Plane outage and recovery, persistence, degraded health while the database is
 * stopped, revocation, the single-use token refused on replay, and the identity guard.
 *
 * Skipped — and reported as BLOCKED, never as passed — when Docker or the edge image is missing.
 * Everything uses psacc-dep-* Compose projects and is removed afterwards.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import type { webcrypto as WebCrypto } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer } from 'node:net';
import * as x509 from '@peculiar/x509';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { ensureTestLicense } from './agent-helpers.js';
import { type Client, EMAIL, ORIGIN, asApp, ids, signedIn, startApp } from './helpers.js';

const WSL = process.platform === 'win32';
const shSync = (cmd: string) => {
  const r = WSL ? spawnSync('wsl', ['--exec', 'bash', '-c', cmd], { encoding: 'utf8', timeout: 60_000 }) : spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}`.trim() };
};
/** Asynchronous shell: the agent gateway in this process must keep serving while commands run. */
function sh(cmd: string, timeout = 240_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = WSL ? spawn('wsl', ['--exec', 'bash', '-c', cmd]) : spawn('bash', ['-c', cmd]);
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out: out.trim(), err: err.trim() });
    });
  });
}
const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const IMAGE = `psacc/psa-edge:${VERSION}`;
// Module 13: the Control Plane under test advertises a newer standard image; the appliances start on IMAGE and one is upgraded on the host.
const NEXT_VERSION = `${VERSION}-next`;
const NEXT_IMAGE = `psacc/psa-edge:${NEXT_VERSION}`;
const ready = shSync(`docker info --format '{{.ServerVersion}}' && docker image inspect ${IMAGE} --format ok && docker image inspect postgres:17-alpine --format ok`).code === 0;
if (!ready) console.warn(`BLOCKED: Docker Engine, ${IMAGE} or postgres:17-alpine is not available; edge installation tests are skipped.`);
// Containers reach this host by its address (WSL mirrored networking) or the docker0 bridge (Linux).
const HOST_IP = ready ? (WSL ? shSync(`ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}'`).out : shSync(`ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1`).out) : '';

let app: NestExpressApplication;
let ops: Client;
let tech: Client; // holds deployments.commands.issue (Module 13)
let gwPort = 0;
let winTmp = '';
const work = `/tmp/psacc-edgetest-${process.pid}`;
type Inst = { id: string; code: string; project: string; dir: string; provider: string; port: number; services: string[]; settings: Record<string, unknown>; credentialKeys: string[] };
const inst: Inst[] = [];
/** A fake PSA REST endpoint on the host (custom REST adapter): TLS with a self-signed certificate, checks the API key header. */
const fakePsa: {
  server?: HttpsServer; port: number; caPem: string; calls: { path: string; ok: boolean }[]; expect: Record<string, string>;
  tickets: Record<string, unknown>[]; patches: { id: string; body: unknown }[]; notes: { id: string; body: unknown }[]; created: unknown[];
} = { port: 0, caPem: '', calls: [], expect: {}, tickets: [], patches: [], notes: [], created: [] };
// Timestamps are relative to the run's clock (whole seconds): the engine's watermark follows the newest PSA
// change, so fixed dates in the future would hide later changes made by the scenario (the conflict step).
const hoursAgo = (h: number): string => new Date(Math.floor(Date.now() / 1000) * 1000 - h * 3_600_000).toISOString().replace('.000Z', 'Z');
const FAKE_TICKETS = [
  { id: '1001', title: 'Printer offline on floor 2', description: 'The HP on floor 2 shows E-04.', status: 'Open', priority: 'High', requesterEmail: 'anna@client.example', createdAt: hoursAgo(30), updatedAt: hoursAgo(3) },
  { id: '1002', title: 'VPN drops every hour', description: 'Since Monday.', status: 'Waiting Customer', priority: 'Medium', requesterEmail: 'ben@client.example', createdAt: hoursAgo(29), updatedAt: hoursAgo(2) },
  { id: '1003', title: 'New starter laptop', description: 'Starts Monday.', status: 'Complete', priority: 'Low', requesterEmail: 'hr@client.example', createdAt: hoursAgo(50), updatedAt: hoursAgo(1), resolvedAt: hoursAgo(1) },
];
async function startFakePsa(): Promise<void> {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = (await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as unknown as WebCrypto.CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name: `CN=${HOST_IP}`, notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000), signingAlgorithm: alg, keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'ip', value: HOST_IP }]), new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const keyDer = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${keyDer.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  fakePsa.caPem = cert.toString('pem');
  fakePsa.tickets = FAKE_TICKETS.map((t) => ({ ...t })); // present from the start, like a real PSA at first sync
  fakePsa.port = await freePort();
  fakePsa.server = createHttpsServer({ key: keyPem, cert: fakePsa.caPem }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x');
    const authed = req.headers['x-api-key'] === fakePsa.expect.apiKey;
    const ok = req.method === 'GET' && url.pathname === '/api/health' && authed;
    fakePsa.calls.push({ path: url.pathname, ok });
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (!authed) { res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid api key' })); return; }
      if (req.method === 'GET' && url.pathname === '/api/health') { res.end(JSON.stringify({ status: 'ok', product: 'Fake PSA' })); return; }
      if (req.method === 'GET' && url.pathname === '/api/tickets') {
        const since = new Date(url.searchParams.get('updated_since') ?? 0).getTime();
        res.end(JSON.stringify({ items: fakePsa.tickets.filter((t) => new Date((t as { updatedAt: string }).updatedAt).getTime() >= since), nextPage: null }));
        return;
      }
      const m = /^\/api\/tickets\/([^/]+)(\/notes)?$/.exec(url.pathname);
      if (req.method === 'PATCH' && m && !m[2]) {
        fakePsa.patches.push({ id: m[1]!, body });
        const t = fakePsa.tickets.find((x) => (x as { id: string }).id === m[1]) as Record<string, unknown> | undefined;
        if (t && body?.status) { t.status = body.status; t.updatedAt = new Date().toISOString(); }
        res.end('{}');
        return;
      }
      if (req.method === 'POST' && m && m[2]) { fakePsa.notes.push({ id: m[1]!, body }); res.statusCode = 201; res.end('{}'); return; }
      if (req.method === 'POST' && url.pathname === '/api/tickets') { fakePsa.created.push(body); res.statusCode = 201; res.end(JSON.stringify({ id: `new-${fakePsa.created.length}` })); return; }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => fakePsa.server!.listen(fakePsa.port, '0.0.0.0', r));
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '0.0.0.0', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
async function download(c: Client, path: string): Promise<Buffer> {
  const res = await request(app.getHttpServer()).post(`/api/v1${path}`).set('cookie', c.cookieHeader).set('origin', ORIGIN)
    .set('x-csrf-token', c.cookies.get('psacc_csrf') ?? '').buffer(true)
    .parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (d: Buffer) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  expect(res.status).toBe(200);
  return res.body as Buffer;
}
const toUnix = (p: string) => (WSL ? shSync(`wslpath -a '${p}'`).out : p);
/** Never install over a Compose project that already exists on this engine: it could be a real appliance (its cleanup would remove it). */
async function refuseExistingProject(project: string): Promise<void> {
  const containers = (await sh(`docker ps -aq --filter label=com.docker.compose.project=${project} | wc -l`)).out.trim();
  const volumes = (await sh(`docker volume ls -q --filter label=com.docker.compose.project=${project} | wc -l`)).out.trim();
  if (containers !== '0' || volumes !== '0') throw new Error(`refusing to install ${project}: a Compose project with that name already exists on this engine (${containers} containers, ${volumes} volumes)`);
}
const dc = (i: Inst, args: string, timeout?: number) => sh(`cd ${i.dir} && docker compose -f compose.yaml ${args}`, timeout);
const ownerSql = (i: Inst, sql: string) =>
  dc(i, `exec -T edge-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_owner_password)" psql -h 127.0.0.1 -U psa_edge_owner -d psa_edge -v ON_ERROR_STOP=1 -qtAX' <<'SQL'\n${sql}\nSQL`);
const roleSql = (i: Inst, role: 'psa_edge_app' | 'psa_edge_inspector', secret: string, sql: string) =>
  sh(`cd ${i.dir} && docker compose -f compose.yaml exec -T -e PGPASSWORD="$(cat secrets/${secret})" edge-postgres psql -h 127.0.0.1 -U ${role} -d psa_edge -v ON_ERROR_STOP=1 -qtAX <<'SQL'\n${sql}\nSQL`);
async function http(i: Inst, args: string) {
  const r = await sh(`curl -s -o /dev/stderr -w '%{http_code}' -b ${work}/${i.project}.jar -c ${work}/${i.project}.jar ${args} 2>${work}/${i.project}.body; echo; cat ${work}/${i.project}.body`, 30_000);
  const [status, ...body] = r.out.split('\n');
  return { status: Number(status), body: body.join('\n') };
}
const agentStatus = async (i: Inst) => JSON.parse((await dc(i, 'exec -T edge-agent edge-agent status')).out);
const detail = async (i: Inst) => (await ops.get(`/deployments/${i.id}`)).body;
async function waitFor(fn: () => Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!ready)('two client appliances installed from generated packages, enrolled over mTLS, on a real Docker Engine', () => {
  beforeAll(async () => {
    gwPort = await freePort();
    // The upgrade scenario needs a second image whose binary reports a different version. Built once; cached by Docker afterwards.
    if (shSync(`docker image inspect ${NEXT_IMAGE} --format ok`).code !== 0) {
      const b = await sh(`cd '${WSL ? '/mnt/e/PSA COntrole center' : process.cwd()}' && EDGE_VERSION=${NEXT_VERSION} node scripts/edge.mjs build`, 600_000);
      if (b.code !== 0) throw new Error(`could not build ${NEXT_IMAGE}: ${b.err.slice(-800)}`);
    }
    app = await startApp({ AGENT_GATEWAY_URL: `https://${HOST_IP}:${gwPort}`, EDGE_HEARTBEAT_SECONDS: '15', EDGE_IMAGE_VERSION: NEXT_VERSION });
    await app.get(AgentGateway).start(gwPort, '0.0.0.0');
    winTmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'psacc-edge-')));
    ops = await signedIn(app, EMAIL.ops);
    tech = await signedIn(app, EMAIL.tech);
    const { orgA } = await ids();
    await startFakePsa();
    for (const seeded of ['autotask', 'connectwise']) {
      let provider = seeded;
      const row = await asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query(
        `SELECT i.id AS psa, i.client_id FROM psa_instances i JOIN clients cl ON cl.id = i.client_id
         WHERE i.provider_key = $1 AND i.status = 'active' AND cl.status NOT IN ('suspended', 'offboarded') AND cl.code <> 'CL-00001'
           AND EXISTS (SELECT 1 FROM psa_instance_services s WHERE s.psa_instance_id = i.id) ORDER BY i.code LIMIT 1`, [provider])).rows[0]);
      if (seeded === 'autotask') {
        // The first appliance tests against the fake PSA on this host over TLS: a custom REST instance for the same client
        // (Autotask zone URLs must be on autotask.net, so the Autotask adapter is covered by the Go unit tests instead).
        const d = (await ops.get(`/psa-instances/${row.psa}`)).body;
        const created = await ops.post('/psa-instances', {
          clientId: row.client_id, providerKey: 'custom_rest', displayName: 'Fake PSA (connection test)', authMethod: 'api_key',
          config: { baseUrl: `https://${HOST_IP}:${fakePsa.port}/api`, healthPath: '/health', apiKeyHeader: 'X-API-Key' },
          enabledServiceIds: d.enabledServices.map((x: { id: string }) => x.id),
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.apiEndpoint).toBe(`https://${HOST_IP}:${fakePsa.port}/api`);
        row.psa = created.body.id;
        provider = 'custom_rest';
      }
      // Give Help Desk explicit settings (Module 4 configuration requirements) so the package and the appliance can be checked for them.
      const svcs = (await ops.get(`/clients/${row.client_id}/services`)).body as { id: string; key: string }[];
      const helpDesk = svcs.find((s) => s.key === 'help_desk');
      if (helpDesk) {
        const saved = await ops.put(`/clients/${row.client_id}/services`, { serviceIds: svcs.map((s) => s.id), config: { [helpDesk.id]: { defaultPriority: 'high', supportHours: '24x7' } } });
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      }
      await ensureTestLicense(ops, row.client_id as string);
      const dep = (await ops.post('/deployments', { clientId: row.client_id, psaInstanceId: row.psa, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' })).body;
      const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
      const file = join(winTmp, p.fileName);
      writeFileSync(file, await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`));
      const project = `psacc-${dep.code.toLowerCase()}`;
      const dir = `${work}/${project}-x/${project}`;
      await refuseExistingProject(project);
      expect((await sh(`mkdir -p ${work}/${project}-x && cd ${work}/${project}-x && unzip -q "${toUnix(file)}"`)).code).toBe(0);
      const cfg = JSON.parse((await sh(`cat ${dir}/config/edge.json`)).out);
      inst.push({ id: dep.id, code: dep.code, project, dir, provider, port: 18000 + (Number(dep.code.replace(/\D/g, '')) % 1000),
        services: cfg.services.map((s: { key: string }) => s.key).sort(), settings: Object.fromEntries(cfg.services.map((s: { key: string; settings: unknown }) => [s.key, s.settings])),
        credentialKeys: cfg.psa.credentialFields.map((f: { key: string }) => f.key) });
    }
    for (const i of inst) {
      expect((await sh(`cd ${i.dir} && cp config/edge.env.template .env && echo EDGE_BACKUP_INITIAL_DELAY_SECONDS=3 >> .env && echo PSA_EDGE_IMAGE=${IMAGE} >> .env`)).code).toBe(0);
      const r = await sh(`cd ${i.dir} && scripts/install.sh`, 400_000);
      if (r.code !== 0) {
        const logs = await sh(`cd ${i.dir} && docker compose -f compose.yaml logs --no-log-prefix edge-migrate edge-postgres 2>&1 | tail -40`, 60_000);
        expect(r.code, `${i.code} install: ${r.err || r.out}
--- logs:
${logs.out}`).toBe(0);
      }
    }
    for (const i of inst) {
      await waitFor(async () => (await dc(i, 'ps --format "{{.Service}} {{.Health}}"')).out.includes('edge-api healthy'), 150_000, `${i.code} edge-api healthy`);
      try {
        await waitFor(async () => ['enrolled', 'verified'].includes((await detail(i)).lifecycleState), 120_000, `${i.code} enrolled`);
      } catch (err) {
        const ps = (await dc(i, 'ps -a --format "{{.Service}} {{.State}} {{.ExitCode}} {{.Health}}"')).out;
        const logs = (await dc(i, 'logs --no-log-prefix --tail 25 edge-migrate edge-agent', 60_000));
        throw new Error(`${(err as Error).message}\n--- compose ps ---\n${ps}\n--- logs ---\n${logs.out}\n${logs.err}`);
      }
    }
  }, 900_000);

  afterAll(async () => {
    fakePsa.server?.close();
    for (const i of inst) await dc(i, 'down --volumes --remove-orphans', 180_000);
    await sh(`rm -rf ${work}`);
    if (winTmp) rmSync(winTmp, { recursive: true, force: true });
    await app?.get(AgentGateway).stop();
    await app?.close();
  }, 400_000);

  it('each agent enrolled with its single-use token; verify.sh passes all 13 checks', async () => {
    for (const i of inst) {
      const d = await detail(i);
      expect(['enrolled', 'verified']).toContain(d.lifecycleState); // verified as soon as healthy reports arrive
      expect(d.agentVersion).toBe(VERSION);
      expect(d.agentCertificates).toHaveLength(1);
      expect(d.agentCertificates[0]).toMatchObject({ status: 'active', issuedVia: 'enrollment', installationId: d.installationId });
      expect(d.packages[0]).toMatchObject({ status: 'consumed', token: { status: 'consumed' }, downloadable: false });
      const r = await sh(`cd ${i.dir} && scripts/verify.sh`, 120_000);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('13 passed, 0 failed');
      expect(r.out).toContain('PASS  Agent enrolled with the Control Plane');
      expect(await agentStatus(i)).toMatchObject({ enrolled: true, state: 'enrolled', serial: d.agentCertificates[0].serial });
    }
    const [a, b] = inst as [Inst, Inst];
    expect((await detail(a)).installationId).not.toBe((await detail(b)).installationId);
  }, 300_000);

  it('heartbeats arrive over mutual TLS and move the deployment’s last-seen time', async () => {
    for (const i of inst) {
      const first = new Date((await detail(i)).lastHeartbeatAt).getTime();
      await waitFor(async () => new Date((await detail(i)).lastHeartbeatAt).getTime() > first, 60_000, `${i.code} next heartbeat`);
    }
  }, 180_000);

  it('real reports make each deployment healthy and verified; the Control Plane holds only measured metadata', async () => {
    for (const i of inst) {
      await waitFor(async () => (await detail(i)).lifecycleState === 'verified', 120_000, `${i.code} verified`);
      const h = (await ops.get(`/deployments/${i.id}/health`)).body;
      expect(h).toMatchObject({ healthState: 'healthy', healthReason: null, lifecycleState: 'verified' });
      expect(Object.keys(h.latest).sort()).toEqual(['backup', 'certificates_security', 'containers', 'database', 'host_resources', 'psa_integration_status', 'synchronization', 'ticket_processing_metrics', 'versions']);
      expect(h.latest.database.payload).toMatchObject({ available: true, schemaVersion: '0006', migrationsApplied: 6 });
      expect(h.latest.database.payload.tables).toHaveLength(14);
      expect(h.latest.host_resources.payload.cpuPercent).not.toBeNull();
      expect(h.latest.host_resources.payload.diskTotalBytes).toBeGreaterThan(0);
      expect(h.latest.containers.payload.services.map((s: { name: string; state: string }) => `${s.name}:${s.state}`).sort()).toEqual(['edge-agent:up', 'edge-api:up', 'edge-backup:up', 'edge-postgres:up', 'edge-worker:up']);
      expect(h.latest.certificates_security.payload).toMatchObject({ certificateSerial: (await detail(i)).agentCertificates[0].serial, encryptedDiskConfirmed: null });
      expect(h.latest.psa_integration_status.payload).toMatchObject({ apiCallsImplemented: true, status: 'not_configured', consecutiveFailures: 0 });
      expect(JSON.stringify(h)).not.toMatch(/psacc_enr_|PRIVATE KEY|e2e-DEP-/);
      expect(h.events.map((e: { healthState: string }) => e.healthState)).toContain('healthy');
      // Database Explorer: the schema snapshot (columns, keys, indexes) arrives from the real catalog.
      await waitFor(async () => (await ops.get(`/deployments/${i.id}/database`)).body.inspection?.pendingTables === 0, 120_000, `${i.code} schema details`);
      const db = (await ops.get(`/deployments/${i.id}/database`)).body;
      expect(db.database).toMatchObject({ databaseName: 'psa_edge', available: true, schemaVersion: '0006', tableCount: 14 });
      expect(db.inspection.detailedTables).toBe(14);
      expect(db.tables.map((t: { name: string }) => t.name)).toContain('helpdesk_tickets');
      const t = (await ops.get(`/deployments/${i.id}/database/tables/public/helpdesk_tickets`)).body;
      expect(t.primaryKey).toMatchObject({ columns: ['id'] });
      expect(t.columns).toHaveLength(21); // 17 from 0001 + 4 synchronization columns (0004)
      expect(t.columns.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['id', 'psa_connection_id', 'title', 'status', 'priority', 'created_at']));
      expect(t.columns.find((c: { name: string }) => c.name === 'status')).toMatchObject({ type: 'text', nullable: false, default: "'new'::text" });
      expect(t.columns.find((c: { name: string }) => c.name === 'id')).toMatchObject({ type: 'uuid', default: 'gen_random_uuid()' });
      expect(t.foreignKeys.some((f: { referencedTable: string }) => f.referencedTable === 'psa_connections')).toBe(true);
      expect(t.indexes.some((x: { primary: boolean; definition: string }) => x.primary && x.definition.includes('USING btree (id)'))).toBe(true);
      expect(t.stats.totalBytes).toBeGreaterThan(0);
      expect(JSON.stringify(t)).not.toMatch(/psacc_enr_|PRIVATE KEY|"rows"|"sample"/);
    }
    const fleet = (await ops.get('/monitoring/fleet?live=1')).body;
    expect(fleet.rows.filter((r: { code: string }) => inst.some((i) => i.code === r.code)).every((r: { healthState: string }) => r.healthState === 'healthy')).toBe(true);
  }, 240_000);

  it('database initialized once with the 14 tables, this deployment’s identity and its own PSA and services', async () => {
    for (const i of inst) {
      const tables = (await ownerSql(i, `SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'`)).out.split(',');
      expect(tables).toEqual(['app_metadata', 'audit_events', 'backup_runs', 'credential_store', 'helpdesk_tickets', 'integration_logs', 'local_admin_sessions',
        'local_admin_users', 'psa_connection_tests', 'psa_connections', 'schema_migrations', 'service_configurations', 'sync_runs', 'ticket_events']);
      expect((await ownerSql(i, `SELECT value FROM app_metadata WHERE key = 'deployment.code'`)).out).toBe(i.code);
      expect((await ownerSql(i, `SELECT version || ':' || name FROM schema_migrations ORDER BY version`)).out).toBe('0001:initial\n0002:health_status\n0003:psa_connection_tests\n0004:ticket_sync\n0005:remote_commands\n0006:client_deletion');
      expect((await ownerSql(i, `SELECT provider || ':' || status FROM psa_connections`)).out).toBe(`${i.provider}:not_configured`);
      expect((await ownerSql(i, `SELECT string_agg(service_key, ',' ORDER BY service_key) FROM service_configurations WHERE enabled`)).out.split(',')).toEqual(i.services);
      // The client's non-secret settings for each service travelled in the package and are stored on the appliance (Module 4).
      const stored = JSON.parse((await ownerSql(i, `SELECT json_object_agg(service_key, settings) FROM service_configurations WHERE enabled`)).out);
      expect(stored).toEqual(i.settings);
      if (i.services.includes('help_desk')) expect(stored.help_desk).toEqual({ defaultPriority: 'high', supportHours: '24x7' });
      const again = await dc(i, 'run --rm -T edge-migrate', 120_000);
      expect(again.code, again.err).toBe(0);
      expect(JSON.parse(again.out.slice(again.out.indexOf('{\n')))).toMatchObject({ applied: null, schemaVersion: '0006', verified: true });
      expect((await ownerSql(i, `SELECT count(*) FROM audit_events WHERE action = 'appliance.migrated'`)).out).toBe('2');
    }
    expect(inst[0]!.provider).not.toBe(inst[1]!.provider);
  }, 240_000);

  it('least privilege: the inspector reads only the catalog; the application cannot rewrite audit or logs', async () => {
    const i = inst[0]!;
    const denied = await roleSql(i, 'psa_edge_inspector', 'inspector_db_password', 'SELECT count(*) FROM helpdesk_tickets');
    expect(denied.code).not.toBe(0);
    expect(denied.err).toMatch(/permission denied for table helpdesk_tickets/);
    const inv = await roleSql(i, 'psa_edge_inspector', 'inspector_db_password', `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_total_relation_size(c.oid) > 0; SELECT schema_version FROM edge_schema_status()`);
    expect(inv.out.split('\n')).toEqual(['14', '0006']);
    for (const sql of ["UPDATE audit_events SET actor = 'x'", 'DELETE FROM integration_logs', 'DROP TABLE helpdesk_tickets', "INSERT INTO backup_runs (status) VALUES ('running')"]) {
      const r = await roleSql(i, 'psa_edge_app', 'app_db_password', sql);
      expect(r.code, sql).not.toBe(0);
      expect(r.err, sql).toMatch(/permission denied|must be owner/);
    }
    expect((await roleSql(i, 'psa_edge_app', 'app_db_password', "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'psa_edge_app'")).out).toBe('f');
  }, 120_000);

  it('local admin UI: loopback only, first-run setup, CSRF, and credentials encrypted with the host key', async () => {
    const [a, b] = inst as [Inst, Inst];
    const base = (i: Inst) => `http://127.0.0.1:${i.port}`;
    const health = await http(a, `${base(a)}/healthz`);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok', database: 'up', version: VERSION });
    expect((await http(a, `-H 'Host: evil.example' ${base(a)}/`)).status).toBe(421);
    expect((await http(a, `${base(a)}/`)).status).toBe(303);
    expect((await http(a, `-X POST -d username=localadmin -d password=short -d confirm=short ${base(a)}/setup`)).status).toBe(422);
    const pw = `edge-${a.code}-local-admin-pass`;
    expect((await http(a, `-X POST --data-urlencode username=localadmin --data-urlencode password=${pw} --data-urlencode confirm=${pw} ${base(a)}/setup`)).status).toBe(303);
    expect((await http(a, `-X POST -d username=second -d password=another-long-pass -d confirm=another-long-pass ${base(a)}/setup`)).status).toBe(409);
    const form = await http(a, `${base(a)}/credentials`);
    expect(form.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)![1]!;
    const values = Object.fromEntries(a.credentialKeys.map((k) => [k, `e2e-${a.code}-${k}-value`]));
    const fields = a.credentialKeys.map((k) => `--data-urlencode field_${k}=${values[k]}`).join(' ');
    expect((await http(a, `-X POST ${fields} ${base(a)}/credentials`)).status).toBe(403);
    expect((await http(a, `-X POST -H 'Origin: https://evil.example' --data-urlencode csrf=${csrf} ${fields} ${base(a)}/credentials`)).status).toBe(403);
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} ${fields} ${base(a)}/credentials`)).status).toBe(303);
    const status = JSON.parse((await http(a, `${base(a)}/api/status`)).body);
    expect(status.psa).toMatchObject({ credentialsPresent: a.credentialKeys.length, status: 'credentials_present', connectionTested: false });
    expect(status.enrollment).toMatchObject({ enrolled: true, state: 'enrolled' });
    expect(status.database.tables).toHaveLength(14);
    expect(JSON.stringify(status)).not.toContain(values[a.credentialKeys[0]!]!);
    for (const v of Object.values(values)) {
      expect((await ownerSql(a, `SELECT count(*) FROM credential_store WHERE position(convert_to('${v}', 'UTF8') IN ciphertext) > 0`)).out).toBe('0');
    }
    expect((await ownerSql(a, `SELECT string_agg(action, ',' ORDER BY occurred_at) FROM audit_events WHERE actor_type = 'local_admin'`)).out).toBe('local_admin.created,psa_credentials.updated');
    expect((await ownerSql(b, `SELECT count(*) FROM credential_store`)).out).toBe('0');
    expect((await ownerSql(b, `SELECT count(*) FROM local_admin_users`)).out).toBe('0');
  }, 120_000);

  it('PSA connection test runs on the appliance against the (fake) PSA over TLS with a private CA; the Control Plane only learns the outcome', async () => {
    const [a, b] = inst as [Inst, Inst];
    const base = (i: Inst) => `http://127.0.0.1:${i.port}`;
    const csrfOf = async (i: Inst) => /name="csrf" value="([^"]+)"/.exec((await http(i, `${base(i)}/credentials`)).body)![1]!;
    // The credentials saved in the previous test are what the fake PSA expects.
    fakePsa.expect = Object.fromEntries(a.credentialKeys.map((k) => [k, `e2e-${a.code}-${k}-value`]));
    const csrf = await csrfOf(a);
    // Without the private CA the test fails on TLS — and says so.
    let r = await http(a, `-X POST --data-urlencode csrf=${csrf} ${base(a)}/credentials/test`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Connection test failed');
    expect(r.body).toContain('tls_error');
    // Trust the fake PSA's certificate (what an on-premise PSA with a private CA needs), then test again.
    writeFileSync(join(winTmp, 'fake-psa-ca.pem'), fakePsa.caPem);
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} --data-urlencode "field_tlsCaCertificate@${toUnix(join(winTmp, 'fake-psa-ca.pem'))}" ${base(a)}/credentials`)).status).toBe(303);
    r = await http(a, `-X POST --data-urlencode csrf=${csrf} ${base(a)}/credentials/test`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Connection verified');
    expect(r.body).toContain('Custom REST');
    expect(fakePsa.calls.filter((c) => c.ok).length).toBeGreaterThanOrEqual(1);
    expect(fakePsa.calls.every((c) => c.path === '/api/health')).toBe(true);
    let status = JSON.parse((await http(a, `${base(a)}/api/status`)).body);
    expect(status.psa).toMatchObject({ status: 'verified', connectionTested: true, lastTest: { ok: true, code: 'ok', httpStatus: 200, testedBy: 'local_admin' } });
    expect((await ownerSql(a, `SELECT status || ':' || coalesce(last_test_code, '') || ':' || (last_success_at IS NOT NULL)::text FROM psa_connections`)).out).toBe('verified:ok:true');
    expect(Number((await ownerSql(a, `SELECT count(*) FROM psa_connection_tests`)).out)).toBeGreaterThanOrEqual(2);
    expect((await ownerSql(a, `SELECT count(*) FROM audit_events WHERE action = 'psa_connection.tested' AND outcome = 'success'`)).out).toBe('1');
    // Nothing secret in what the appliance keeps about the test, nor in what it sends.
    const secretValue = fakePsa.expect.apiKey!;
    expect((await ownerSql(a, `SELECT count(*) FROM psa_connection_tests WHERE detail LIKE '%${secretValue}%' OR remote_identity::text LIKE '%${secretValue}%'`)).out).toBe('0');
    expect((await ownerSql(a, `SELECT count(*) FROM integration_logs WHERE message LIKE '%${secretValue}%'`)).out).toBe('0');

    // The Control Plane learns the outcome from the agent's next report: instance verified with the real success time.
    const psaId = (await detail(a)).psaInstance.id as string;
    await waitFor(async () => (await ops.get(`/psa-instances/${psaId}`)).body.connectionStatus === 'succeeded', 90_000, `${a.code} PSA instance succeeded`);
    const instance = (await ops.get(`/psa-instances/${psaId}`)).body;
    expect(instance).toMatchObject({ connectionStatus: 'succeeded', credentialStatus: 'configured' });
    expect(instance.lastSuccessfulTestAt).not.toBeNull();
    expect(instance.appliance).toMatchObject({ deployment: { code: a.code }, status: 'verified', lastTestCode: 'ok', lastTestHttpStatus: 200, lastTestedBy: 'local_admin', apiCallsImplemented: true, remoteIdentity: { api: 'Custom REST', path: '/health' } });
    const tests = (await ops.get(`/psa-instances/${psaId}/connection-tests`)).body;
    expect(tests[0]).toMatchObject({ ok: true, code: 'ok', httpStatus: 200, testedBy: 'local_admin', deployment: { code: a.code } });
    // The Control Plane's history holds the tests observed by reports (every 15 s here); the appliance keeps every test locally.
    expect(Number((await ownerSql(a, `SELECT count(*) FROM psa_connection_tests WHERE code = 'tls_error'`)).out)).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify([instance, tests])).not.toContain(secretValue);
    expect((await ops.get('/integrations')).body.find((x: { id: string }) => x.id === psaId)).toMatchObject({ connectionStatus: 'succeeded', appliance: { lastTestCode: 'ok' } });

    // A wrong secret: the PSA answers 401, the appliance reports auth_failed and the Control Plane marks the credentials invalid.
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} --data-urlencode field_apiKey=wrong-${a.code} ${base(a)}/credentials`)).status).toBe(303);
    r = await http(a, `-X POST --data-urlencode csrf=${csrf} ${base(a)}/credentials/test`);
    expect(r.body).toContain('Connection test failed');
    expect(r.body).toContain('auth_failed');
    expect(r.body).toContain('HTTP 401');
    expect(r.body).not.toContain(`wrong-${a.code}`);
    await waitFor(async () => (await ops.get(`/psa-instances/${psaId}`)).body.connectionStatus === 'failed', 90_000, `${a.code} PSA instance failed`);
    expect((await ops.get(`/psa-instances/${psaId}`)).body).toMatchObject({ connectionStatus: 'failed', credentialStatus: 'invalid' });
    expect((await ops.get(`/deployments/${a.id}/health`)).body.findings.map((f: { code: string }) => f.code)).toContain('psa_failed');
    // Restore the right secret so the rest of the suite sees a healthy appliance.
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} --data-urlencode field_apiKey=${fakePsa.expect.apiKey} ${base(a)}/credentials`)).status).toBe(303);
    r = await http(a, `-X POST --data-urlencode csrf=${csrf} ${base(a)}/credentials/test`);
    expect(r.body).toContain('Connection verified');

    // Appliance B has no credentials: the test is refused before any request leaves the appliance.
    expect((await http(b, `-X POST --data-urlencode username=localadmin --data-urlencode password=edge-${b.code}-local-admin-pass --data-urlencode confirm=edge-${b.code}-local-admin-pass ${base(b)}/setup`)).status).toBe(303);
    const csrfB = await csrfOf(b);
    r = await http(b, `-X POST --data-urlencode csrf=${csrfB} ${base(b)}/credentials/test`);
    expect(r.body).toContain('not_configured');
    status = JSON.parse((await http(b, `${base(b)}/api/status`)).body);
    expect(status.psa).toMatchObject({ status: 'not_configured', connectionTested: true, lastTest: { ok: false, code: 'not_configured' } });
  }, 300_000);

  it('ticket synchronization: the appliance mirrors the (fake) PSA, pushes local changes back, keeps conflicts, and the Control Plane sees counts only', async () => {
    const [a] = inst as [Inst, Inst];
    const base = `http://127.0.0.1:${a.port}`;
    const csrf = /name="csrf" value="([^"]+)"/.exec((await http(a, `${base}/credentials`)).body)![1]!;
    // The worker's initial run (right after the connection was verified) mirrored the three tickets; "Sync now" runs again. Scheduled runs
    // keep the default 5-minute interval here so every step below is driven by explicit requests (no race with the sequence).
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} ${base}/sync/run`)).status).toBe(303);
    await waitFor(async () => (await ownerSql(a, `SELECT count(*) FROM sync_runs WHERE status = 'succeeded'`)).out !== '0', 90_000, `${a.code} first sync`);
    expect((await ownerSql(a, `SELECT count(*) FROM helpdesk_tickets WHERE origin = 'psa'`)).out).toBe('3');
    expect((await ownerSql(a, `SELECT external_ticket_id || ':' || status || ':' || priority || ':' || sync_state FROM helpdesk_tickets ORDER BY external_ticket_id`)).out.split('\n')).toEqual(['1001:open:high:synced', '1002:pending:normal:synced', '1003:closed:low:synced']);
    expect((await ownerSql(a, `SELECT count(*) FROM ticket_events WHERE event_type = 'created' AND source = 'psa'`)).out).toBe('3');
    // The watermark is the later of the newest PSA change seen and the run start (the overlap covers skew).
    const watermark = new Date((await ownerSql(a, `SELECT value FROM app_metadata WHERE key = 'sync.inbound.watermark'`)).out).getTime();
    expect(watermark).toBeGreaterThanOrEqual(new Date(FAKE_TICKETS[2]!.updatedAt).getTime());
    expect(watermark).toBeLessThanOrEqual(Date.now());
    const run = JSON.parse((await ownerSql(a, `SELECT row_to_json(r) FROM (SELECT trigger, status, items_received, items_sent, items_failed, pages FROM sync_runs WHERE items_received = 3 ORDER BY started_at LIMIT 1) r`)).out);
    expect(run).toMatchObject({ status: 'succeeded', items_received: 3, items_sent: 0, items_failed: 0, pages: 1 });
    expect(['initial', 'scheduled', 'manual']).toContain(run.trigger);
    // "Sync now" is consumed by the worker on its next tick (every 30 s).
    await waitFor(async () => (await ownerSql(a, `SELECT count(*) FROM sync_runs WHERE trigger = 'manual'`)).out !== '0', 90_000, `${a.code} manual sync run`);

    // The local admin UI lists them; a status change and a note recorded here are pushed to the PSA by the next run.
    const list = await http(a, `${base}/tickets`);
    expect(list.status).toBe(200);
    expect(list.body).toContain('Printer offline on floor 2');
    const localId = (await ownerSql(a, `SELECT id FROM helpdesk_tickets WHERE external_ticket_id = '1001'`)).out;
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} --data-urlencode action=status --data-urlencode status=pending ${base}/tickets/${localId}`)).status).toBe(303);
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} --data-urlencode action=note --data-urlencode "text=Called Anna, waiting for a photo of the error" ${base}/tickets/${localId}`)).status).toBe(303);
    expect((await ownerSql(a, `SELECT sync_state FROM helpdesk_tickets WHERE id = '${localId}'`)).out).toBe('pending_push');
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} ${base}/sync/run`)).status).toBe(303);
    await waitFor(async () => fakePsa.patches.length >= 1 && fakePsa.notes.length >= 1, 90_000, `${a.code} outbound push`);
    expect(fakePsa.patches[0]).toMatchObject({ id: '1001', body: { status: 'pending' } });
    expect(fakePsa.notes[0]).toMatchObject({ id: '1001', body: { text: 'Called Anna, waiting for a photo of the error' } });
    await waitFor(async () => (await ownerSql(a, `SELECT sync_state FROM helpdesk_tickets WHERE id = '${localId}'`)).out === 'synced', 60_000, `${a.code} ticket synced after push`);
    expect((await ownerSql(a, `SELECT count(*) FROM ticket_events WHERE source = 'portal' AND pushed_at IS NOT NULL`)).out).toBe('2');

    // A ticket raised on the appliance is created in the (custom REST) PSA and gets its id.
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} --data-urlencode "title=Raised on the appliance" --data-urlencode "description=Keyboard broken" --data-urlencode priority=normal ${base}/tickets`)).status).toBe(303);
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} ${base}/sync/run`)).status).toBe(303);
    await waitFor(async () => fakePsa.created.length >= 1, 90_000, `${a.code} create pushed`);
    expect(fakePsa.created[0]).toMatchObject({ title: 'Raised on the appliance', status: 'new', priority: 'normal' });
    await waitFor(async () => (await ownerSql(a, `SELECT external_ticket_id FROM helpdesk_tickets WHERE origin = 'portal'`)).out === 'new-1', 60_000, `${a.code} external id assigned`);

    // Conflict: the PSA closes a ticket while a local status change waits → the PSA wins, a conflict event is kept.
    const vpn = (await ownerSql(a, `SELECT id FROM helpdesk_tickets WHERE external_ticket_id = '1002'`)).out;
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} --data-urlencode action=status --data-urlencode status=open ${base}/tickets/${vpn}`)).status).toBe(303);
    const t2 = fakePsa.tickets.find((t) => (t as { id: string }).id === '1002') as Record<string, unknown>;
    t2.status = 'Closed';
    t2.updatedAt = new Date().toISOString();
    t2.resolvedAt = t2.updatedAt;
    const patchesBefore = fakePsa.patches.length;
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} ${base}/sync/run`)).status).toBe(303);
    try {
      await waitFor(async () => (await ownerSql(a, `SELECT count(*) FROM ticket_events WHERE event_type = 'sync_conflict'`)).out === '1', 90_000, `${a.code} conflict recorded`);
    } catch (err) {
      const runs = (await ownerSql(a, `SELECT concat_ws(' ', started_at, trigger, status, 'recv=' || coalesce(items_received, 0), 'sent=' || coalesce(items_sent, 0), 'failed=' || coalesce(items_failed, 0), coalesce(error_code, ''), coalesce(error_message, '')) FROM sync_runs ORDER BY started_at DESC LIMIT 4`)).out;
      const ticket = (await ownerSql(a, `SELECT status || ' ' || sync_state || ' ext=' || coalesce(external_updated_at::text, 'null') || ' synced=' || coalesce(last_synced_at::text, 'null') FROM helpdesk_tickets WHERE id = '${vpn}'`)).out;
      const events = (await ownerSql(a, `SELECT occurred_at || ' ' || event_type || ' ' || source || ' pushed=' || coalesce(pushed_at::text, 'null') || ' err=' || coalesce(push_error, '') FROM ticket_events WHERE ticket_id = '${vpn}' ORDER BY occurred_at`)).out;
      const wm = (await ownerSql(a, `SELECT value FROM app_metadata WHERE key = 'sync.inbound.watermark'`)).out;
      throw new Error(`${(err as Error).message}
--- runs:
${runs}
--- ticket: ${ticket}
--- events:
${events}
--- watermark: ${wm}
--- fake ticket 1002: ${JSON.stringify(t2)}
--- fake calls: ${JSON.stringify(fakePsa.calls.slice(-6))}`);
    }
    expect((await ownerSql(a, `SELECT status || ':' || sync_state FROM helpdesk_tickets WHERE id = '${vpn}'`)).out).toBe('closed:conflict');
    expect(fakePsa.patches.length).toBe(patchesBefore); // the superseded local status was not pushed
    expect((await http(a, `${base}/tickets/${vpn}`)).body).toContain('sync_conflict');

    // The Control Plane learns counts and statuses only: no title, description or note text in any report.
    // The agent reports every few seconds; wait for the report that carries the conflict, not an earlier one.
    await waitFor(async () => {
      const m = (await ops.get(`/deployments/${a.id}/health`)).body.latest.ticket_processing_metrics?.payload ?? {};
      return (m.ticketsTotal ?? 0) >= 4 && (m.conflictsLast24h ?? 0) >= 1;
    }, 90_000, `${a.code} ticket counts (with the conflict) reported`);
    const h = (await ops.get(`/deployments/${a.id}/health`)).body;
    expect(h.latest.ticket_processing_metrics.payload).toMatchObject({ ticketsTotal: 4, conflictsLast24h: 1 });
    expect(h.latest.synchronization.payload).toMatchObject({ implemented: true, lastStatus: 'succeeded' });
    expect(h.latest.synchronization.payload.runsLast24h).toBeGreaterThanOrEqual(4);
    const psaId = (await detail(a)).psaInstance.id as string;
    expect((await ops.get(`/psa-instances/${psaId}`)).body.appliance).toMatchObject({ sync: { implemented: true, lastStatus: 'succeeded' }, tickets: { total: 4 } });
    const { orgA } = await ids();
    const leaked = await asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query(
      `SELECT count(*)::int AS n FROM deployment_reports WHERE deployment_id = $1 AND (payload::text ILIKE '%Printer offline%' OR payload::text ILIKE '%Keyboard broken%' OR payload::text ILIKE '%Called Anna%' OR payload::text ILIKE '%client.example%')`, [a.id])).rows[0].n as number);
    expect(leaked).toBe(0);
  }, 420_000);

  it('remote commands: signed by the Control Plane, pulled and verified by the agent, executed on the appliance (refresh, PSA test, sync, restart, certificate rotation), and an upgrade staged, applied on the host and reported', async () => {
    const [a] = inst as [Inst, Inst];
    const base = `http://127.0.0.1:${a.port}`;
    type Cmd = { id: string; status: string; deliveredAt: string | null; result: { code: string; message: string; agentVersion: string } | null; params: Record<string, unknown> };
    const issue = async (type: string, params?: Record<string, unknown>) => {
      const r = await tech.post(`/deployments/${a.id}/commands`, { type, ...(params ? { params } : {}), expiresInMinutes: 15 });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const cmd = async (id: string) => ((await tech.get(`/deployments/${a.id}/operations`)).body.commands as Cmd[]).find((c) => c.id === id)!;
    const settled = async (id: string, label: string) => {
      await waitFor(async () => ['succeeded', 'failed', 'staged'].includes((await cmd(id)).status), 120_000, `${a.code} ${label}`);
      return cmd(id);
    };
    const opsBefore = (await tech.get(`/deployments/${a.id}/operations`)).body;
    expect(opsBefore).toMatchObject({ canIssue: true, runningVersion: VERSION, upToDate: false, upgradeTarget: { repository: 'psacc/psa-edge', version: NEXT_VERSION } });

    // 1. refresh_health: the agent collects and delivers at once.
    const r1 = await settled(await issue('refresh_health'), 'refresh_health');
    expect(r1).toMatchObject({ status: 'succeeded', result: { code: 'reports_delivered', agentVersion: VERSION } });
    expect(r1.deliveredAt).not.toBeNull();

    // 2. test_psa_connection: relayed to the worker through the shared volume; the real test runs against the fake PSA.
    const r2 = await settled(await issue('test_psa_connection'), 'test_psa_connection');
    expect(r2, JSON.stringify(r2.result)).toMatchObject({ status: 'succeeded', result: { code: 'ok' } });
    expect(r2.result!.message).toMatch(/HTTP 200/);
    expect((await ownerSql(a, `SELECT count(*) FROM psa_connection_tests WHERE tested_by = 'remote'`)).out).not.toBe('0');

    // 3. run_sync: one synchronization pass now, recorded with the "remote" trigger.
    const r3 = await settled(await issue('run_sync'), 'run_sync');
    expect(r3, JSON.stringify(r3.result)).toMatchObject({ status: 'succeeded' });
    expect(r3.result!.message).toMatch(/^Synchronization succeeded/);
    expect((await ownerSql(a, `SELECT count(*) FROM sync_runs WHERE trigger = 'remote' AND status = 'succeeded'`)).out).not.toBe('0');

    // 4. restart_service edge-worker: the worker answers, exits cleanly and Docker Compose starts it again.
    const restarts = async () => Number((await sh(`cd ${a.dir} && docker inspect --format '{{.RestartCount}}' $(docker compose -f compose.yaml ps -q edge-worker)`)).out || '0');
    const rc0 = await restarts();
    const r4 = await settled(await issue('restart_service', { service: 'edge-worker' }), 'restart_service');
    expect(r4, JSON.stringify(r4.result)).toMatchObject({ status: 'succeeded', result: { code: 'restarting' } });
    await waitFor(async () => (await restarts()) > rc0, 60_000, `${a.code} worker restarted by Compose`);
    await waitFor(async () => (await dc(a, 'ps --status running --services')).out.split('\n').includes('edge-worker'), 60_000, `${a.code} worker running again`);
    expect((await ownerSql(a, `SELECT count(*) FROM integration_logs WHERE message LIKE 'Restart requested by a signed remote command%'`)).out).not.toBe('0');

    // 5. rotate_certificate: a new machine certificate for the same installation; the old one is retired; heartbeats continue.
    const serial0 = (await detail(a)).agentCertificates.find((c: { status: string }) => c.status === 'active').serial as string;
    const r5 = await settled(await issue('rotate_certificate'), 'rotate_certificate');
    expect(r5, JSON.stringify(r5.result)).toMatchObject({ status: 'succeeded', result: { code: 'certificate_renewed' } });
    const certs = (await detail(a)).agentCertificates as { serial: string; status: string }[];
    expect(certs.find((c) => c.status === 'active')!.serial).not.toBe(serial0);
    expect(certs.find((c) => c.serial === serial0)!.status).toBe('superseded');

    // 6. upgrade: the agent verifies and stages the signed order; it never touches Docker itself.
    const upId = await issue('upgrade');
    const r6 = await settled(upId, 'upgrade staged');
    expect(r6, JSON.stringify(r6.result)).toMatchObject({ status: 'staged', result: { code: 'staged' }, params: { repository: 'psacc/psa-edge', version: NEXT_VERSION } });
    expect(r6.result!.message).toContain('scripts/upgrade.sh');
    expect((await agentStatus(a)).commands.stagedUpgrade).toMatchObject({ commandId: upId, image: NEXT_IMAGE, fromVersion: VERSION });
    const dash = (await http(a, `${base}/`)).body;
    const orderFile = await dc(a, 'cp edge-api:/var/log/psa-edge/remote/upgrade-order.json - | tar -xO', 30_000);
    const renderErrors = (await dc(a, "logs --no-log-prefix edge-api 2>&1 | grep -i 'render failed' | tail -2", 30_000)).out;
    expect(dash, `dashboard has remote section: ${dash.includes('Remote commands')}; render errors: ${renderErrors.slice(0, 600)}; tail: ${dash.slice(-300)}; order via edge-api: ${orderFile.out.slice(0, 200)}`).toContain('Upgrade staged'); // the local admin shows the host instructions
    expect((await ownerSql(a, `SELECT count(*) FROM helpdesk_tickets`)).out).toBe('4');
    // The host operator applies it with the package script: pull, record in .env, recreate the services.
    const up = await sh(`cd ${a.dir} && scripts/upgrade.sh`, 300_000);
    expect(up.code, up.err + up.out).toBe(0);
    expect(up.out).toContain(`The appliance now runs ${NEXT_IMAGE}`);
    expect((await sh(`cd ${a.dir} && grep '^PSA_EDGE_IMAGE=' .env`)).out).toBe(`PSA_EDGE_IMAGE=${NEXT_IMAGE}`);
    // The new agent sees the staged order matches its version and reports success; the Control Plane sees the new version.
    // The staged command stays 'staged' until the upgraded agent reports; wait for that final answer, not the staging one.
    await waitFor(async () => ['succeeded', 'failed'].includes((await cmd(upId)).status), 150_000, `${a.code} upgrade applied`);
    const r7 = await cmd(upId);
    expect(r7, JSON.stringify(r7.result)).toMatchObject({ status: 'succeeded', result: { code: 'upgraded', agentVersion: NEXT_VERSION } });
    await waitFor(async () => (await tech.get(`/deployments/${a.id}/operations`)).body.runningVersion === NEXT_VERSION, 90_000, `${a.code} new version reported`);
    expect((await tech.get(`/deployments/${a.id}/operations`)).body).toMatchObject({ runningVersion: NEXT_VERSION, upToDate: true });
    expect((await tech.post(`/deployments/${a.id}/commands`, { type: 'upgrade' })).status).toBe(409); // already up to date
    expect((await agentStatus(a)).commands.stagedUpgrade).toBeUndefined();
    // Data, identity and the local UI survived the upgrade; the verify script still passes.
    expect((await ownerSql(a, `SELECT count(*) FROM helpdesk_tickets`)).out).toBe('4');
    expect((await http(a, `${base}/healthz`)).status).toBe(200);
    expect((await agentStatus(a)).state).toBe('enrolled');
    const v = await sh(`cd ${a.dir} && scripts/verify.sh`, 120_000);
    expect(v.out).not.toContain('FAIL');
    // Every step is in the audit trail, with the agent as the actor for completions.
    const audit = (await tech.get(`/deployments/${a.id}/activity?pageSize=100`)).body.items as { action: string; actorType: string }[];
    expect(audit.filter((e) => e.action === 'deployment.command.issued')).toHaveLength(6);
    expect(audit.filter((e) => e.action === 'deployment.command.completed' && e.actorType === 'agent').length).toBeGreaterThanOrEqual(6);
    expect(audit.some((e) => e.action === 'deployment.command.staged')).toBe(true);
  }, 900_000);

  it('lifecycle: suspending the deployment pauses PSA work on the real appliance (signed command), keeps data and the local UI, blocks packages and commands centrally; resuming restores everything', async () => {
    const [a] = inst as [Inst, Inst];
    const base = `http://127.0.0.1:${a.port}`;
    type Cmd = { id: string; type: string; status: string; result: { code: string; message: string } | null };
    const commands = async () => (await tech.get(`/deployments/${a.id}/operations?limit=100`)).body.commands as Cmd[];
    const settled = async (type: string, label: string) => {
      await waitFor(async () => (await commands()).some((c) => c.type === type && ['succeeded', 'failed'].includes(c.status)), 120_000, `${a.code} ${label}`);
      return (await commands()).find((c) => c.type === type)!;
    };
    const runsBefore = Number((await ownerSql(a, `SELECT count(*) FROM sync_runs`)).out);
    const stateBefore = (await detail(a)).lifecycleState as string;

    // Suspend from the Control Plane: lifecycle + signed command to the appliance.
    const sus = await ops.post(`/deployments/${a.id}/suspend`, { reason: 'Customer paused the contract' });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect(sus.body).toMatchObject({ lifecycleState: 'suspended', suspension: { reason: 'Customer paused the contract', fromState: stateBefore } });
    const r1 = await settled('suspend', 'suspend command');
    expect(r1, JSON.stringify(r1.result)).toMatchObject({ status: 'succeeded', result: { code: 'suspended' } });
    // The appliance recorded it: flag in app_metadata, log entry, banner on its pages, "Sync now" disabled.
    expect((await ownerSql(a, `SELECT count(*) FROM app_metadata WHERE key = 'service.suspended'`)).out).toBe('1');
    expect((await ownerSql(a, `SELECT count(*) FROM integration_logs WHERE message LIKE 'Suspended by the provider%'`)).out).not.toBe('0');
    const dash = (await http(a, `${base}/`)).body;
    expect(dash).toContain('suspended-banner');
    expect(dash).toContain('Customer paused the contract');
    expect((await http(a, `${base}/sync`)).body).toMatch(/<button class="btn" type="submit" disabled>Sync now<\/button>/);
    // Tickets and data stay available locally; nothing was deleted.
    expect((await ownerSql(a, `SELECT count(*) FROM helpdesk_tickets`)).out).toBe('4');
    expect((await http(a, `${base}/tickets`)).status).toBe(200);
    // PSA work is paused: a "Sync now" request stays unconsumed and no run appears; the periodic test does not run either.
    const csrf = /name="csrf" value="([^"]+)"/.exec((await http(a, `${base}/credentials`)).body)![1]!;
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} ${base}/sync/run`)).status).toBe(303);
    await new Promise((r) => setTimeout(r, 40_000)); // longer than the worker tick (30 s)
    expect(Number((await ownerSql(a, `SELECT count(*) FROM sync_runs`)).out)).toBe(runsBefore);
    expect((await ownerSql(a, `SELECT count(*) FROM app_metadata WHERE key = 'sync.requested'`)).out).toBe('1');
    // Centrally: no package, no operator command; the health carries the lifecycle finding; heartbeats continue.
    expect((await ops.post(`/deployments/${a.id}/packages`, { tokenValidityHours: 1 })).status).toBe(422);
    const blocked = await tech.post(`/deployments/${a.id}/commands`, { type: 'refresh_health' });
    expect(blocked.status).toBe(409);
    expect((await ops.get(`/deployments/${a.id}/health`)).body.findings.map((f: { code: string }) => f.code)).toContain('deployment_suspended');
    const hb0 = new Date((await detail(a)).lastHeartbeatAt).getTime();
    await waitFor(async () => new Date((await detail(a)).lastHeartbeatAt).getTime() > hb0, 60_000, `${a.code} heartbeats while suspended`);

    // Resume: the previous state returns, the appliance resumes and the waiting "Sync now" runs.
    const res = await ops.post(`/deployments/${a.id}/resume`, { reason: 'Contract resumed' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.lifecycleState).toBe(stateBefore);
    const r2 = await settled('resume', 'resume command');
    expect(r2, JSON.stringify(r2.result)).toMatchObject({ status: 'succeeded', result: { code: 'resumed' } });
    expect((await ownerSql(a, `SELECT count(*) FROM app_metadata WHERE key = 'service.suspended'`)).out).toBe('0');
    await waitFor(async () => Number((await ownerSql(a, `SELECT count(*) FROM sync_runs`)).out) > runsBefore, 90_000, `${a.code} synchronization resumed`);
    expect((await http(a, `${base}/`)).body).not.toContain('suspended-banner');
    expect((await tech.post(`/deployments/${a.id}/commands`, { type: 'refresh_health' })).status).toBe(201);
    const activity = (await ops.get(`/deployments/${a.id}/activity?pageSize=50`)).body.items.map((e: { action: string }) => e.action);
    expect(activity).toEqual(expect.arrayContaining(['deployment.suspended', 'deployment.resumed']));
  }, 600_000);

  it('reports stay metadata-only in the local outbox; the backup service makes a verified backup', async () => {
    for (const i of inst) {
      await waitFor(async () => (await ownerSql(i, `SELECT count(*) FROM backup_runs WHERE status = 'succeeded'`)).out === '1', 90_000, `${i.code} first backup`);
      const [file, sum] = (await ownerSql(i, `SELECT file_name || ' ' || sha256 FROM backup_runs WHERE status = 'succeeded'`)).out.split(' ');
      expect((await dc(i, `exec -T edge-backup sha256sum /backups/${file}`)).out.split(' ')[0]).toBe(sum);
    }
    // Delivered batches leave the outbox; what the Control Plane holds is metadata only.
    const i = inst[0]!;
    const left = (await sh(`docker run --rm -v ${i.project}_edge-logs:/l:ro postgres:17-alpine sh -c 'ls -1 /l/outbox 2>/dev/null | wc -l'`)).out;
    expect(Number(left)).toBeLessThanOrEqual(1); // at most the batch collected since the last delivery
    const latest = (await ops.get(`/deployments/${i.id}/health`)).body.latest;
    expect(latest.database.payload.tables.map((t: { name: string }) => t.name)).toContain('helpdesk_tickets');
    expect(JSON.stringify(latest)).not.toMatch(/psacc_enr_|e2e-DEP-|PRIVATE KEY/);
  }, 180_000);

  it('certificate renewal: a new certificate for the same installation; the old one is retired', async () => {
    const a = inst[0]!;
    const before = (await detail(a)).agentCertificates[0].serial;
    const r = await dc(a, 'exec -T edge-agent edge-agent renew', 60_000);
    expect(r.code, r.err).toBe(0);
    const d = await detail(a);
    const chain = d.agentCertificates.map((c: { issuedVia: string; status: string }) => `${c.issuedVia}:${c.status}`) as string[];
    expect(chain[0]).toBe('renewal:active'); // newest first; earlier certificates (enrollment, remote rotation) are retired
    expect(chain.slice(1).every((x) => x.endsWith(':superseded'))).toBe(true);
    expect(chain[chain.length - 1]).toBe('enrollment:superseded');
    expect(d.agentCertificates[0].serial).not.toBe(before);
    expect(JSON.parse(r.out).serial).toBe(d.agentCertificates[0].serial);
    const t = new Date(d.lastHeartbeatAt).getTime();
    await waitFor(async () => new Date((await detail(a)).lastHeartbeatAt).getTime() > t, 60_000, 'heartbeat with the renewed certificate');
  }, 180_000);

  it('Control Plane outage: the appliance keeps working locally; heartbeats resume when the gateway returns', async () => {
    const a = inst[0]!;
    await app.get(AgentGateway).stop();
    await waitFor(async () => !!(await agentStatus(a)).lastError, 60_000, 'agent notices the outage');
    const st = await agentStatus(a);
    expect(st).toMatchObject({ enrolled: true, state: 'enrolled' }); // identity is kept
    expect((await http(a, `http://127.0.0.1:${a.port}/healthz`)).status).toBe(200);
    const stale = new Date((await detail(a)).lastHeartbeatAt).getTime();
    await app.get(AgentGateway).start(gwPort, '0.0.0.0');
    await waitFor(async () => new Date((await detail(a)).lastHeartbeatAt).getTime() > stale, 60_000, 'heartbeat after the outage');
    await waitFor(async () => !(await agentStatus(a)).lastError, 30_000, 'agent error cleared');
  }, 240_000);

  it('identity and data survive down/up; health degrades while the database is stopped and recovers after real checks', async () => {
    const i = inst[0]!;
    const base = `http://127.0.0.1:${i.port}`;
    const serial = (await detail(i)).agentCertificates[0].serial;
    const certCount = (await detail(i)).agentCertificates.length;
    expect((await dc(i, 'down', 180_000)).code).toBe(0);
    expect((await dc(i, 'up -d', 240_000)).code).toBe(0);
    await waitFor(async () => (await dc(i, 'ps --format "{{.Service}} {{.Health}}"')).out.includes('edge-api healthy'), 150_000, 'edge-api healthy after up');
    expect((await ownerSql(i, `SELECT count(*) FROM local_admin_users`)).out).toBe('1');
    expect((await ownerSql(i, `SELECT count(*) FROM credential_store WHERE field_key <> 'tlsCaCertificate'`)).out).toBe(String(i.credentialKeys.length));
    expect(await agentStatus(i)).toMatchObject({ enrolled: true, serial }); // no re-enrollment
    expect((await detail(i)).agentCertificates).toHaveLength(certCount); // no re-enrollment, no new certificate
    expect((await dc(i, 'stop edge-postgres', 120_000)).code).toBe(0);
    await waitFor(async () => (await http(i, `${base}/healthz`)).status === 503, 60_000, 'degraded health');
    expect(JSON.parse((await http(i, `${base}/healthz`)).body)).toMatchObject({ status: 'degraded', database: 'down' });
    // The dashboard reports it critical from the agent's real reports, and healthy again only after real checks.
    await waitFor(async () => (await detail(i)).healthState === 'critical', 90_000, 'Control Plane reports critical');
    expect((await detail(i)).healthReason).toMatch(/PostgreSQL is not available/);
    expect((await dc(i, 'start edge-postgres', 120_000)).code).toBe(0);
    await waitFor(async () => (await http(i, `${base}/healthz`)).status === 200, 90_000, 'recovered health');
    await waitFor(async () => (await detail(i)).healthState === 'healthy', 120_000, 'Control Plane reports healthy again');
    const events = (await ops.get(`/deployments/${i.id}/health`)).body.events.map((e: { healthState: string }) => e.healthState);
    expect(events.slice(0, 2)).toEqual(['healthy', 'critical']);
  }, 600_000);

  it('revocation: the gateway refuses the certificate; replaying the used token is refused too', async () => {
    const b = inst[1]!;
    const r = await ops.post(`/deployments/${b.id}/agent-certificate/revoke`, { reason: 'Test revocation of client B' });
    expect(r.status).toBe(200);
    expect(r.body.lifecycleState).toBe('draft');
    await waitFor(async () => (await agentStatus(b)).state === 'revoked', 60_000, 'agent sees the revocation');
    const v = await sh(`cd ${b.dir} && scripts/verify.sh`, 120_000);
    expect(v.out).toContain('FAIL  Agent enrolled with the Control Plane');
    expect((await http(b, `http://127.0.0.1:${b.port}/healthz`)).status).toBe(200); // still works locally
    // Wipe the agent's identity: it must re-enroll, and the package's token is already used.
    expect((await dc(b, 'stop edge-agent')).code).toBe(0);
    expect((await sh(`docker run --rm -v ${b.project}_agent-state:/s postgres:17-alpine sh -c 'rm -f /s/*'`)).code).toBe(0);
    expect((await dc(b, 'start edge-agent')).code).toBe(0);
    await waitFor(async () => (await agentStatus(b)).state === 'failed', 60_000, 'replayed token refused');
    expect((await agentStatus(b)).lastError).toMatch(/token-used/);
    const audit = (await ops.get(`/deployments/${b.id}/activity`)).body.items.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['agent.enrolled', 'agent.certificate.revoked', 'agent.enrollment.rejected']));
  }, 240_000);

  it('a package refuses to run against a database that belongs to another deployment', async () => {
    const i = inst[0]!;
    const cfg = `${i.dir}/config/edge.json`;
    expect((await sh(`cp ${cfg} ${cfg}.orig && sed -i 's/"id": "[0-9a-f-]\\{36\\}",/"id": "00000000-0000-4000-8000-000000000000",/' ${cfg}`)).code).toBe(0);
    const r = await dc(i, 'run --rm -T edge-migrate', 120_000);
    await sh(`mv ${cfg}.orig ${cfg}`);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toMatch(/this database belongs to deployment/);
  }, 180_000);

  it('license tokens (Module 16): the real appliance verifies its token with the key pinned in the image; a suspended license stops PSA work within a heartbeat and resuming restores it; a tampered token is refused until renewed', async () => {
    const a = inst[0]!;
    const base = `http://127.0.0.1:${a.port}`;
    // Pinned key: the image was built with the Control Plane's license key, and the package carries a token for this installation.
    const st0 = await agentStatus(a);
    expect(st0.license, JSON.stringify(st0.license)).toMatchObject({ state: 'valid', keySource: 'image', psaWorkAllowed: true });
    const keyInfo = (await ops.get('/settings/licensing-key')).body;
    expect(st0.license.keyId).toBe(keyInfo.keyId);
    expect((await sh(`cat ${a.dir}/config/license.json`)).out).toContain(`"keyId": "${keyInfo.keyId}"`);
    const dash0 = (await http(a, `${base}/`)).body;
    expect(dash0).toContain('data-testid="license-state"');
    expect(dash0).not.toContain('license-banner');
    // The verdict reaches the Control Plane in the security report.
    await waitFor(async () => (await detail(a)).applianceLicense?.state === 'valid', 90_000, `${a.code} reports its license verdict`);
    expect((await detail(a)).applianceLicense).toMatchObject({ keySource: 'image', keyId: keyInfo.keyId });

    // Suspend the license on the Control Plane: the next heartbeat answers inactive; the appliance stops PSA work.
    const licId = (await detail(a)).licenseDetail.id;
    expect((await ops.post(`/licenses/${licId}/suspend`, { reason: 'Invoice overdue' })).status).toBe(200);
    await waitFor(async () => (await agentStatus(a)).license?.state === 'revoked', 90_000, `${a.code} agent sees the inactive license`);
    const runsBefore = Number((await ownerSql(a, `SELECT count(*) FROM sync_runs`)).out);
    await waitFor(async () => (await ownerSql(a, `SELECT count(*) FROM integration_logs WHERE message LIKE 'License token revoked%'`)).out !== '0', 60_000, `${a.code} worker logged the stop`);
    const dash1 = (await http(a, `${base}/`)).body;
    expect(dash1).toContain('data-testid="license-banner"');
    expect(dash1).toContain('is suspended'); // the Control Plane states the license status, not the operator's internal reason
    expect((await http(a, `${base}/sync`)).body).toMatch(/<button class="btn" type="submit" disabled>Sync now<\/button>/);
    // A "Sync now" request stays unconsumed for a full worker tick; tickets and data stay.
    const csrf = /name="csrf" value="([^"]+)"/.exec((await http(a, `${base}/credentials`)).body)![1]!;
    expect((await http(a, `-X POST --data-urlencode csrf=${csrf} ${base}/sync/run`)).status).toBe(303);
    await new Promise((r) => setTimeout(r, 40_000));
    expect(Number((await ownerSql(a, `SELECT count(*) FROM sync_runs`)).out)).toBe(runsBefore);
    expect((await http(a, `${base}/tickets`)).status).toBe(200);
    // Centrally: the health carries the appliance's verdict, and heartbeats continue.
    await waitFor(async () => (await detail(a)).applianceLicense?.state === 'revoked', 90_000, `${a.code} reported revoked`);
    expect((await ops.get(`/deployments/${a.id}/health`)).body.findings.map((f: { code: string }) => f.code)).toContain('appliance_license_revoked');

    // Resume the license: the next heartbeat carries a token again; PSA work resumes (the pending Sync now runs).
    expect((await ops.post(`/licenses/${licId}/resume`, { reason: 'Paid' })).status).toBe(200);
    await waitFor(async () => (await agentStatus(a)).license?.state === 'valid', 90_000, `${a.code} token renewed`);
    await waitFor(async () => Number((await ownerSql(a, `SELECT count(*) FROM sync_runs`)).out) > runsBefore, 120_000, `${a.code} synchronization resumed`);
    expect((await http(a, `${base}/`)).body).not.toContain('license-banner');

    // Tampering with the stored token on the host is detected at once and healed by the next renewal. The edge image
    // carries no shell, so the shared volume is edited from a throw-away container (in place, keeping the file's owner).
    const logs = `${a.project}_edge-logs`;
    const current = (await sh(`docker run --rm -v ${logs}:/l:ro postgres:17-alpine cat /l/license/current.json`)).out;
    expect(current).toContain('"token": "psacc-lic.v1.');
    const tampered = current.replace(/"token": "psacc-lic\.v1\.([A-Za-z0-9_-])/, (_, c) => `"token": "psacc-lic.v1.${c === 'A' ? 'B' : 'A'}`);
    expect(tampered).not.toBe(current);
    expect((await sh(`docker run --rm -i -v ${logs}:/l postgres:17-alpine sh -c 'cat > /l/license/current.json' <<'EOF'\n${tampered}\nEOF`)).code).toBe(0);
    expect((await agentStatus(a)).license.state).toBe('invalid');
    await waitFor(async () => (await agentStatus(a)).license?.state === 'valid', 90_000, `${a.code} renewal replaced the tampered token`);
  }, 900_000);

  it('decommissioning (Module 15): the Control Plane retires the identity; the real appliance stops reporting and PSA work, keeps its data and shows the removal page; the host-side wipe removes everything; the record can then be removed', async () => {
    const a = inst[0]!;
    const base = `http://127.0.0.1:${a.port}`;
    const before = await detail(a);
    const tickets = (await ownerSql(a, `SELECT count(*) FROM helpdesk_tickets`)).out;
    const r = await ops.post(`/deployments/${a.id}/decommission`, { reason: 'Contract ended; site closed', confirmCode: a.code });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.decommission).toMatchObject({ fromState: before.lifecycleState, identity: { certificatesRevoked: 1 } });
    // The agent learns it from the gateway (410 decommissioned), stops, and hands it to the worker through the shared volume.
    await waitFor(async () => (await agentStatus(a)).state === 'decommissioned', 90_000, `${a.code} agent sees the decommissioning`);
    const st = await agentStatus(a);
    expect(st.enrolled).toBe(false);
    expect(st.detail).toContain('scripts/uninstall.sh');
    await waitFor(async () => (await ownerSql(a, `SELECT count(*) FROM app_metadata WHERE key = 'service.decommissioned'`)).out === '1', 60_000, `${a.code} worker recorded the decommissioning`);
    expect((await ownerSql(a, `SELECT count(*) FROM integration_logs WHERE message LIKE 'Decommissioned by the provider%'`)).out).not.toBe('0');
    // No heartbeat reaches the Control Plane any more; tickets, data and the local admin stay on the host.
    const hb = (await detail(a)).lastHeartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 35_000));
    expect((await detail(a)).lastHeartbeatAt).toBe(hb);
    expect((await ownerSql(a, `SELECT count(*) FROM helpdesk_tickets`)).out).toBe(tickets);
    expect((await http(a, `${base}/`)).body).toContain('decommissioned-banner');
    const removal = await http(a, `${base}/removal`);
    expect(removal.status).toBe(200);
    expect(removal.body).toContain(`--wipe --confirm ${a.code}`);
    expect((await http(a, `${base}/sync`)).body).toMatch(/<button class="btn" type="submit" disabled>Sync now<\/button>/);
    expect((await http(a, `${base}/tickets`)).status).toBe(200);
    // Centrally it is final: no package, no command, no resume; health says why.
    expect((await ops.post(`/deployments/${a.id}/packages`, { tokenValidityHours: 1 })).status).toBe(422);
    expect((await tech.post(`/deployments/${a.id}/commands`, { type: 'refresh_health' })).status).toBe(409);
    expect((await ops.post(`/deployments/${a.id}/resume`, { reason: 'back' })).status).toBe(409);
    expect((await ops.get(`/deployments/${a.id}/health`)).body.findings.map((f: { code: string }) => f.code)).toEqual(['deployment_decommissioned']);
    // Host side: the wipe needs the typed deployment ID; afterwards nothing of the project remains.
    expect((await sh(`cd ${a.dir} && scripts/uninstall.sh --wipe --confirm DEP-00000`)).code).not.toBe(0);
    const wipe = await sh(`cd ${a.dir} && scripts/uninstall.sh --wipe --confirm ${a.code}`, 300_000);
    expect(wipe.code, wipe.err || wipe.out).toBe(0);
    expect(wipe.out).toContain('Removed: no container, network, volume or secret');
    expect((await sh(`docker ps -a --format '{{ .Names }}' | grep -c '^${a.project}-' || true`)).out.trim()).toBe('0');
    expect((await sh(`docker volume ls -q | grep -c '^${a.project}_' || true`)).out.trim()).toBe('0');
    expect((await sh(`test -e ${a.dir}/secrets && echo present || echo gone`)).out.trim()).toBe('gone');
    // The record can be removed from the Control Plane now; the audit trail stays with the client.
    const rm = await ops.del(`/deployments/${a.id}`, { confirmCode: a.code });
    expect(rm.status, JSON.stringify(rm.body)).toBe(200);
    expect(rm.body.deleted).toMatchObject({ deployments: 1, certificates: expect.any(Number) });
    expect((await ops.get(`/deployments/${a.id}`)).status).toBe(404);
    const activity = (await ops.get(`/clients/${before.client.id}/activity?pageSize=100`)).body.items.map((e: { action: string; targetId: string }) => `${e.action}@${e.targetId}`);
    for (const action of ['agent.enrolled', 'deployment.decommissioned', 'deployment.removed']) expect(activity).toContain(`${action}@${a.id}`);
  }, 900_000);

  it('client-initiated deletion (Module 17): the local administrator deletes everything from the appliance; the Control Plane keeps only the audit event; the host wipe needs no --force', async () => {
    const b = inst[1]!;
    const base = `http://127.0.0.1:${b.port}`;
    const pw = `edge-${b.code}-local-admin-pass`;
    // Appliance B lost its identity in the revocation scenario (certificate revoked, state file wiped, the package's
    // token already used). The Module 15 runbook applies first: re-enroll with a new package — the package files are
    // refreshed in place, the agent state cleared, and the stack restarted so every service reads the new config.
    expect((await agentStatus(b)).state).toBe('failed');
    const pkg2 = (await ops.post(`/deployments/${b.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
    const file2 = join(winTmp, pkg2.fileName);
    writeFileSync(file2, await download(ops, `/deployments/${b.id}/packages/${pkg2.id}/download`));
    // The package files are installed read-only (the install script tightens their modes): replace them, do not overwrite in place.
    const refresh = await sh(`mkdir -p ${work}/${b.project}-re && cd ${work}/${b.project}-re && unzip -q "${toUnix(file2)}" && for f in enrollment/enrollment.json config/edge.json config/license.json; do cp -f ${b.project}/$f ${b.dir}/$f && chmod 444 ${b.dir}/$f; done`); // world-readable like the installer leaves them (the containers run as another uid)
    expect(refresh.code, refresh.err || refresh.out).toBe(0);
    expect((await dc(b, 'stop edge-agent')).code).toBe(0);
    expect((await sh(`docker run --rm -v ${b.project}_agent-state:/s postgres:17-alpine sh -c 'rm -f /s/*'`)).code).toBe(0);
    // A file bind mount follows the inode it was created with: the replaced files are only seen by recreated containers
    // (a plain restart would keep serving the old token). Migrate runs again and records the new installation id.
    expect((await dc(b, 'up -d --force-recreate --wait --wait-timeout 120', 240_000)).code).toBe(0);
    try {
      await waitFor(async () => (await agentStatus(b)).state === 'enrolled', 90_000, `${b.code} re-enrolled with the new package`);
    } catch (err) {
      throw new Error(`${(err as Error).message}; agent status ${JSON.stringify(await agentStatus(b))}`);
    }
    await waitFor(async () => ['enrolled', 'verified'].includes((await detail(b)).lifecycleState as string), 90_000, `${b.code} enrolled on the Control Plane`);
    const before = await detail(b);
    expect((await http(b, `-X POST --data-urlencode username=localadmin --data-urlencode password=${pw} ${base}/login`)).status).toBe(303);
    const page = await http(b, `${base}/deletion`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('data-testid="deletion-form"');
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1]!;
    // A wrong deployment ID, a wrong password or a missing acknowledgement change nothing.
    expect((await http(b, `-X POST --data-urlencode csrf=${csrf} --data-urlencode confirm=DEP-00000 --data-urlencode password=${pw} --data-urlencode acknowledge=on ${base}/deletion`)).status).toBe(400);
    expect((await http(b, `-X POST --data-urlencode csrf=${csrf} --data-urlencode confirm=${b.code} --data-urlencode password=wrong-${pw} --data-urlencode acknowledge=on ${base}/deletion`)).status).toBe(400);
    expect((await http(b, `-X POST --data-urlencode csrf=${csrf} --data-urlencode confirm=${b.code} --data-urlencode password=${pw} ${base}/deletion`)).status).toBe(400);
    expect((await detail(b)).lifecycleState).toBe(before.lifecycleState);
    expect((await agentStatus(b)).deletion).toBeUndefined();
    // The real request: PSA work stops, every other page is locked to the progress page.
    expect((await http(b, `-X POST --data-urlencode csrf=${csrf} --data-urlencode confirm=${b.code} --data-urlencode password=${pw} --data-urlencode acknowledge=on --data-urlencode "reason=Moving to another provider" ${base}/deletion`)).status).toBe(303);
    expect((await http(b, `${base}/tickets`)).status).toBe(303);
    expect((await ownerSql(b, `SELECT count(*) FROM app_metadata WHERE key = 'service.deletion_requested'`)).out).toBe('1');
    // Control Plane: the record is gone; the audit event on the client says who, from where, and what was deleted.
    try {
      await waitFor(async () => (await ops.get(`/deployments/${b.id}`)).status === 404, 90_000, `${b.code} deleted on the Control Plane`);
    } catch (err) {
      throw new Error(`${(err as Error).message}; agent status ${JSON.stringify((await agentStatus(b)).deletion ?? null)}; agent log: ${(await dc(b, 'logs --tail 30 edge-agent', 60_000)).out.slice(-3000)}`);
    }
    const activity = (await ops.get(`/clients/${before.client.id}/activity?pageSize=100`)).body.items as { id: string; action: string; targetId: string; actorType: string; metadata: Record<string, unknown> }[];
    const ev = activity.find((e) => e.action === 'deployment.deleted_by_client' && e.targetId === b.id)!;
    expect(ev, JSON.stringify(activity.map((e) => e.action))).toBeTruthy();
    expect(ev.actorType).toBe('agent');
    expect(ev.metadata).toMatchObject({ code: b.code, requestedBy: 'localadmin', reason: 'Moving to another provider', installationId: before.installationId });
    expect((ev.metadata.deleted as Record<string, number>).deployments).toBe(1);
    expect(activity.some((e) => e.action === 'agent.enrolled' && e.targetId === b.id)).toBe(true); // the trail before it stays
    // Appliance: the agent finishes with no identity; the database holds nothing but the marker; the shared files are gone.
    await waitFor(async () => (await agentStatus(b)).state === 'deleted', 180_000, `${b.code} agent finished the deletion`);
    const st = await agentStatus(b);
    expect(st.deletion).toMatchObject({ phase: 'wiped', controlPlaneNotified: true, requestedBy: 'localadmin', auditEventId: ev.id });
    expect(st.deletion.controlPlaneDeleted.deployments).toBe(1);
    expect(st.deletion.deleted.helpdesk_tickets).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(st)).not.toContain('psacc-lic.v1.');
    for (const table of ['helpdesk_tickets', 'ticket_events', 'credential_store', 'psa_connections', 'local_admin_users', 'local_admin_sessions', 'audit_events', 'integration_logs', 'sync_runs']) {
      expect((await ownerSql(b, `SELECT count(*) FROM ${table}`)).out, table).toBe('0');
    }
    expect((await ownerSql(b, `SELECT count(*) FROM app_metadata`)).out).toBe('1');
    expect((await ownerSql(b, `SELECT value FROM app_metadata WHERE key = 'service.deleted'`)).out).toContain(`|${b.code}`);
    expect((await sh(`docker run --rm -v ${b.project}_agent-state:/s:ro postgres:17-alpine sh -c 'ls -1 /s'`)).out.trim()).toBe('state.json');
    expect((await sh(`docker run --rm -v ${b.project}_edge-logs:/l:ro postgres:17-alpine sh -c 'ls -1 /l'`)).out).not.toMatch(/outbox|license/);
    // The final page is readable without a session and shows the one command left; no sign-in or setup is possible any more.
    const done = await http(b, `${base}/deletion`);
    expect(done.status).toBe(200);
    expect(done.body).toContain('data-testid="deletion-done"');
    expect(done.body).toContain(`--wipe --confirm ${b.code}`);
    expect((await http(b, `${base}/setup`)).status).toBe(303);
    expect((await http(b, `${base}/login`)).status).toBe(303);
    // Host side: the wipe needs no --force now (the agent reports 'deleted'); afterwards nothing of the project remains.
    const wipe = await sh(`cd ${b.dir} && scripts/uninstall.sh --wipe --confirm ${b.code}`, 300_000);
    expect(wipe.code, wipe.err || wipe.out).toBe(0);
    expect(wipe.out).toContain('Removed: no container, network, volume or secret');
    expect((await sh(`docker ps -a --format '{{ .Names }}' | grep -c '^${b.project}-' || true`)).out.trim()).toBe('0');
    expect((await sh(`docker volume ls -q | grep -c '^${b.project}_' || true`)).out.trim()).toBe('0');
  }, 900_000);
});
