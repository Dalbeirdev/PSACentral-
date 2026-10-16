/**
 * Fleet-scale load test (backlog TEST-LOAD): LOAD_AGENTS simulated agents (default 1,000) enroll
 * through the real package → token → CSR → mTLS flow, then run LOAD_CYCLES heartbeat + full-report
 * cycles against the gateway while the health sweep keeps evaluating. Measures gateway latency,
 * sweep duration, fleet query time and storage growth, and writes the results to
 * docs/reports/module-10/load-test.json. Thresholds are the "keeps up" criteria: no failed requests,
 * p95 below one heartbeat interval, and a sweep that finishes well inside its 30-second period.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { HealthService } from '../../src/modules/health/health.service.js';
import { unzipSync } from 'fflate';
import supertest from 'supertest';
import { type AgentIdentity, gw, healthyReports, keyAndCsr } from '../integration/agent-helpers.js';
import { type Client, EMAIL, ORIGIN, asApp, signedIn, startApp } from '../integration/helpers.js';

const AGENTS = Number(process.env.LOAD_AGENTS ?? 1000);
const CYCLES = Number(process.env.LOAD_CYCLES ?? 3);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const OUT = fileURLToPath(new URL('../../../../docs/reports/module-10/', import.meta.url));

let app: NestExpressApplication;
let port = 0;
let ops: Client;

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);
const stats = (xs: number[]) => ({ count: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), p99: Math.round(pct(xs, 99)), max: Math.round(Math.max(0, ...xs)), mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0 });

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

let targets: { clientId: string; psaInstanceId: string }[] = [];

/** One agent through the real flow, API only: deployment → package → download → token → CSR → certificate. */
async function enrollOne(i: number): Promise<AgentIdentity> {
  const t = targets[i % targets.length]!;
  const dep = (await ops.post('/deployments', { clientId: t.clientId, psaInstanceId: t.psaInstanceId, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64', hostLabel: `load-${i}` })).body;
  if (!dep.id) throw new Error(`deployment: ${JSON.stringify(dep)}`);
  const pkg = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
  if (!pkg?.id) throw new Error('package not generated');
  const res = await supertest(app.getHttpServer()).post(`/api/v1/deployments/${dep.id}/packages/${pkg.id}/download`)
    .set('cookie', ops.cookieHeader).set('origin', ORIGIN).set('x-csrf-token', ops.cookies.get('psacc_csrf') ?? '').buffer(true)
    .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
  if (res.status !== 200) throw new Error(`download ${res.status}`);
  const files = unzipSync(new Uint8Array(res.body as Buffer));
  const en = JSON.parse(Buffer.from(files[`psacc-${dep.code.toLowerCase()}/enrollment/enrollment.json`]!).toString());
  const k = await keyAndCsr(en.installationId);
  const r = await gw(port, '/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: k.csr, agentVersion: '0.1.0' }, en.caCertificate);
  if (r.status !== 201) throw new Error(`enroll ${r.status} ${JSON.stringify(r.body)}`);
  return { keyPem: k.keyPem, certPem: r.body.certificate as string, en: { ...en, packageId: pkg.id } };
}

beforeAll(async () => {
  // Rate limits are resolved lazily from process.env (config/rate-limits.ts); the fleet must not trip them.
  process.env.PACKAGE_RATE_LIMIT_PER_MINUTE = '10000';
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '10000', RATE_LIMIT_PER_MINUTE: '10000', LOG_LEVEL: 'error' });
  const g = app.get(AgentGateway);
  await g.start(0, '127.0.0.1');
  port = g.address!.port;
  ops = await signedIn(app, EMAIL.ops);
  // Spread the fleet over every seeded client that has an active PSA instance with services.
  const active = new Set(((await ops.get('/clients?status=active&pageSize=100')).body.items as { id: string }[]).map((c) => c.id));
  const instances = (await ops.get('/psa-instances?status=active&pageSize=100')).body.items as { id: string; client: { id: string; code: string }; enabledServiceCount: number }[];
  targets = instances.filter((p) => p.enabledServiceCount > 0 && p.client.code !== 'CL-00001' && active.has(p.client.id)).map((p) => ({ clientId: p.client.id, psaInstanceId: p.id }));
  expect(targets.length).toBeGreaterThan(0);
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

describe(`fleet of ${AGENTS} simulated agents`, () => {
  it('enrolls, reports and stays evaluated within the health sweep budget', async () => {
    const result: Record<string, unknown> = { agents: AGENTS, cycles: CYCLES, concurrency: CONCURRENCY, startedAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}` };

    // Phase 1: enrollment through the real flow (deployment → package → token → CSR → certificate).
    const enrollMs: number[] = [];
    const t0 = performance.now();
    // Agents retry transient connection errors (a real agent backs off and tries again); retries are counted.
    let enrollFailures = 0;
    let retries = 0;
    const retrying = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
      for (let n = 1; ; n++) {
        try {
          return await fn();
        } catch (err) {
          if (n >= attempts || !/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up/.test((err as Error).message)) throw err;
          retries++;
          await new Promise((r) => setTimeout(r, 100 * n));
        }
      }
    };
    const agents: AgentIdentity[] = (await pool(Array.from({ length: AGENTS }, (_, i) => i), Math.min(CONCURRENCY, 20), async (i) => {
      const s = performance.now();
      try {
        const a = await retrying(() => enrollOne(i));
        enrollMs.push(performance.now() - s);
        return a;
      } catch (err) {
        enrollFailures++;
        if (enrollFailures <= 3) console.error('enrollment failed:', (err as Error).stack);
        return null;
      }
    })).filter((a): a is AgentIdentity => a !== null);
    result.enrollmentFailures = enrollFailures;
    result.enrollmentRetries = retries;
    result.enrollment = { ...stats(enrollMs), totalSeconds: Math.round((performance.now() - t0) / 100) / 10, perSecond: Math.round(AGENTS / ((performance.now() - t0) / 1000)) };
    expect(agents).toHaveLength(AGENTS);

    // Phase 2: heartbeat + full report cycles; the sweep runs between cycles like its 30-second timer would.
    const cycles: unknown[] = [];
    let failures = 0;
    for (let c = 0; c < CYCLES; c++) {
      const hb: number[] = [];
      const rep: number[] = [];
      const started = performance.now();
      const cycleRetriesBefore = retries;
      const samples: string[] = [];
      await pool(agents, CONCURRENCY, async (a) => {
        let s = performance.now();
        const h = await retrying(() => gw(port, '/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.en.caCertificate, a)).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
        hb.push(performance.now() - s);
        if (h.status !== 200) { failures++; if (samples.length < 3) samples.push(`heartbeat ${h.status} ${JSON.stringify(h.body)}`); }
        s = performance.now();
        const r = await retrying(() => gw(port, '/agent/v1/reports', healthyReports({ host_resources: { cpuPercent: Math.round(Math.random() * 600) / 10 } }), a.en.caCertificate, a)).catch((e: Error) => ({ status: 0, body: { rejected: [1], error: e.message } }));
        rep.push(performance.now() - s);
        if (r.status !== 200 || (r.body.rejected as unknown[]).length) { failures++; if (samples.length < 3) samples.push(`reports ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); }
      });
      if (samples.length) console.error(`cycle ${c + 1} failures (first ${samples.length}):\n${samples.join('\n')}`);
      const cycleRetries = retries - cycleRetriesBefore;
      const cycleSeconds = (performance.now() - started) / 1000;
      const sweepStart = performance.now();
      const orgs = await app.get(HealthService).sweep();
      const sweepMs = performance.now() - sweepStart;
      const fleetStart = performance.now();
      const fleet = await ops.get('/monitoring/fleet?live=1');
      const fleetMs = performance.now() - fleetStart;
      const explorerStart = performance.now();
      const explorer = await ops.get('/database-explorer?live=1');
      const explorerMs = performance.now() - explorerStart;
      expect(fleet.status).toBe(200);
      expect(explorer.status).toBe(200);
      const healthy = (fleet.body.rows as { healthState: string }[]).filter((r) => r.healthState === 'healthy').length;
      cycles.push({ cycle: c + 1, heartbeat: stats(hb), reports: stats(rep), cycleSeconds: Math.round(cycleSeconds * 10) / 10, requestsPerSecond: Math.round((AGENTS * 2) / cycleSeconds), retries: cycleRetries, sweepMs: Math.round(sweepMs), sweptOrganizations: orgs, fleetQueryMs: Math.round(fleetMs), explorerQueryMs: Math.round(explorerMs), fleetRows: fleet.body.rows.length, healthy });
      expect(healthy, `cycle ${c + 1}: healthy agents (fleet summary ${JSON.stringify(fleet.body.summary)}, failures so far ${failures})`).toBeGreaterThanOrEqual(agents.length);
    }
    result.cycles = cycles;
    result.failedRequests = failures;

    // Storage: what the Control Plane keeps per agent and cycle (reports history is pruned after 30 days).
    result.storage = await asApp(null, async (c) => {
      const sizes = await c.query(`SELECT s.relname, pg_total_relation_size(s.relid) AS bytes, s.n_live_tup AS rows FROM pg_stat_user_tables s WHERE s.relname IN ('deployments','deployment_reports','deployment_report_latest','deployment_heartbeats','deployment_tables','agent_certificates','deployment_health_events') ORDER BY s.relname`);
      const db = await c.query('SELECT pg_database_size(current_database()) AS bytes');
      const reportBytes = Number(sizes.rows.find((r) => r.relname === 'deployment_reports')?.bytes ?? 0);
      return {
        tables: sizes.rows.map((r) => ({ table: r.relname, bytes: Number(r.bytes), rows: Number(r.rows) })),
        databaseBytes: Number(db.rows[0].bytes),
        reportBytesPerAgentPerCycle: Math.round(reportBytes / (AGENTS * CYCLES)),
        estimatedReportBytesPerAgentPerDayAt60s: Math.round((reportBytes / (AGENTS * CYCLES)) * 1440),
      };
    });
    result.finishedAt = new Date().toISOString();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}load-test.json`, JSON.stringify(result, null, 2));

    // Keeps-up criteria.
    expect(failures).toBe(0);
    for (const c of cycles as { heartbeat: { p95: number }; reports: { p95: number }; sweepMs: number; fleetQueryMs: number }[]) {
      expect(c.heartbeat.p95, 'heartbeat p95 (ms)').toBeLessThan(1000);
      expect(c.reports.p95, 'reports p95 (ms)').toBeLessThan(2000);
      expect(c.sweepMs, 'sweep duration (ms)').toBeLessThan(20_000);
      expect(c.fleetQueryMs, 'fleet query (ms)').toBeLessThan(5000);
    }
  });
});
