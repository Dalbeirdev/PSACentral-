/** Shared helpers for tests that act as an edge agent against the gateway (enrollment, mTLS calls). */
import { webcrypto } from 'node:crypto';
import type { webcrypto as WebCrypto } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as x509 from '@peculiar/x509';
import { unzipSync } from 'fflate';
import supertest from 'supertest';
import { expect } from 'vitest';
import { type Client, ORIGIN, asApp, ids } from './helpers.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export interface Enrollment { token: string; deploymentId: string; installationId: string; caCertificate: string; caFingerprint: string; deploymentCode: string; packageId: string }
export interface AgentIdentity { keyPem: string; certPem: string; en: Enrollment }

/** A real package for a fresh deployment of the given client, and the enrollment file inside it. */
export async function packageFor(app: NestExpressApplication, ops: Client, clientCode = 'CL-00014'): Promise<Enrollment> {
  const { orgA } = await ids();
  const inOrgA = <T>(fn: (c: import('pg').Client) => Promise<T>) => asApp({ orgId: orgA, scopeAll: true }, fn);
  const clientId = await inOrgA(async (c) => (await c.query('SELECT id FROM clients WHERE code = $1', [clientCode])).rows[0].id as string);
  const psa = await inOrgA(async (c) => (await c.query(`SELECT id FROM psa_instances WHERE client_id = $1 AND status = 'active' ORDER BY code LIMIT 1`, [clientId])).rows[0].id as string);
  await ensureTestLicense(ops, clientId);
  const dep = (await ops.post('/deployments', { clientId, psaInstanceId: psa, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' })).body;
  const pkg = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
  const res = await supertest(app.getHttpServer()).post(`/api/v1/deployments/${dep.id}/packages/${pkg.id}/download`)
    .set('cookie', ops.cookieHeader).set('origin', ORIGIN).set('x-csrf-token', ops.cookies.get('psacc_csrf') ?? '').buffer(true)
    .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
  const files = unzipSync(new Uint8Array(res.body as Buffer));
  const en = JSON.parse(Buffer.from(files[`psacc-${dep.code.toLowerCase()}/enrollment/enrollment.json`]!).toString());
  return { ...en, packageId: pkg.id };
}

export async function keyAndCsr(cn: string): Promise<{ keyPem: string; csr: string }> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as WebCrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${cn}`, keys: keys as never, signingAlgorithm: ALG });
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { keyPem: `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`, csr: csr.toString('pem') };
}

/** HTTPS to the gateway, verifying it against the pinned CA; optionally with the agent's client certificate. */
export function gw(port: number, path: string, body: unknown, ca: string, agent?: { keyPem: string; certPem?: string }, method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port, path, method, ca, rejectUnauthorized: true, key: agent?.certPem ? agent.keyPem : undefined, cert: agent?.certPem, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * Module 14: a deployment needs an active license with free capacity to get a package. The suites create
 * many deployments per client, so each client used by a test gets a large test license once (idempotent;
 * `ops` holds licenses.manage).
 */
export async function ensureTestLicense(ops: Client, clientId: string): Promise<void> {
  const existing = (await ops.get(`/licenses?clientId=${clientId}&status=active&pageSize=50`)).body.items as { displayName: string; deploymentsUsed: number; maxDeployments: number }[];
  if (existing.some((l) => l.displayName === 'Test capacity' && l.deploymentsUsed < l.maxDeployments)) return;
  const r = await ops.post('/licenses', { clientId, displayName: 'Test capacity', startsAt: new Date().toISOString().slice(0, 10), endsAt: null, maxDeployments: 1000 });
  if (r.status !== 201) throw new Error(`test license not created: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Enrolls a fresh identity for a new deployment and returns the mTLS credentials. */
export async function enrolledAgent(app: NestExpressApplication, ops: Client, port: number, clientCode?: string): Promise<AgentIdentity> {
  const en = await packageFor(app, ops, clientCode);
  const k = await keyAndCsr(en.installationId);
  const r = await gw(port, '/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: k.csr, agentVersion: '0.1.0' }, en.caCertificate);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { keyPem: k.keyPem, certPem: r.body.certificate as string, en };
}

/** One table's schema metadata as the agent's inspector reports it. */
export function tableSchema(name: string, over: Record<string, unknown> = {}) {
  const col = (position: number, cname: string, type: string, nullable = false, def: string | null = null) => ({ position, name: cname, type, nullable, default: def, identity: false });
  return {
    schema: 'public', name, kind: 'table',
    columns: [col(1, 'id', 'uuid', false, 'gen_random_uuid()'), col(2, 'psa_connection_id', 'uuid'), col(3, 'subject', 'text'), col(4, 'status', 'text', false, "'open'::text"), col(5, 'created_at', 'timestamp with time zone', false, 'now()')],
    primaryKey: { name: `${name}_pkey`, columns: ['id'] },
    indexes: [
      { name: `${name}_pkey`, unique: true, primary: true, definition: `CREATE UNIQUE INDEX ${name}_pkey ON public.${name} USING btree (id)`, sizeBytes: 8192 },
      { name: `${name}_status_idx`, unique: false, primary: false, definition: `CREATE INDEX ${name}_status_idx ON public.${name} USING btree (status)`, sizeBytes: 8192 },
    ],
    foreignKeys: [{ name: `${name}_psa_connection_id_fkey`, columns: ['psa_connection_id'], referencedSchema: 'public', referencedTable: 'psa_connections', referencedColumns: ['id'], onDelete: 'restrict' }],
    stats: { estimatedRows: 0, liveRows: 0, deadRows: 0, lastAnalyzeAt: null, lastAutoanalyzeAt: null, lastVacuumAt: null, lastAutovacuumAt: null, totalBytes: 40960, tableBytes: 8192, indexBytes: 16384, toastBytes: 0 },
    ...over,
  };
}

/** A database_schema part (one batch) for the given tables. */
export function schemaPart(fingerprint: string, part: number, parts: number, tables: Record<string, unknown>[], observedAt = new Date()) {
  return { agentVersion: '0.1.0', reports: [{ schemaVersion: 1, type: 'database_schema', observedAt: observedAt.toISOString(), payload: { fingerprint, part, parts, tables } }] };
}

/** A complete, healthy set of reports as a real agent would send them. */
export function healthyReports(over: Partial<Record<string, Record<string, unknown>>> = {}, observedAt = new Date()) {
  const at = observedAt.toISOString();
  const base: Record<string, Record<string, unknown>> = {
    database: { available: true, serverVersion: '17.6', schemaVersion: '0002', migrationsApplied: 2, lastMigratedAt: at, sizeBytes: 8_500_000, tables: [
      { schema: 'public', name: 'helpdesk_tickets', estimatedRows: 0, sizeBytes: 40960, columns: 17, hasPrimaryKey: true, indexes: 4, foreignKeys: 1 },
      { schema: 'public', name: 'app_metadata', estimatedRows: null, sizeBytes: 32768, columns: 3, hasPrimaryKey: true, indexes: 1, foreignKeys: 0 },
    ] },
    host_resources: { cpuPercent: 12.5, memoryUsedBytes: 300_000_000, memoryLimitBytes: 2_000_000_000, diskUsedBytes: 40_000_000_000, diskTotalBytes: 100_000_000_000, diskMount: 'docker-volumes', uptimeSeconds: 3600, cpuCount: 4 },
    containers: { services: [
      { name: 'edge-postgres', probe: 'database', state: 'up' }, { name: 'edge-api', probe: 'http', state: 'up' }, { name: 'edge-agent', probe: 'self', state: 'up' },
      { name: 'edge-worker', probe: 'liveness', state: 'up', lastSeenAt: at }, { name: 'edge-backup', probe: 'liveness', state: 'up' },
    ] },
    psa_integration_status: { provider: 'autotask', instanceCode: 'PSA-00001', status: 'credentials_present', credentialFields: 3, credentialsPresent: 3, lastTestAt: null, lastTestResult: null, apiCallsImplemented: false },
    ticket_processing_metrics: { ticketsTotal: 0, ticketsOpen: 0, eventsLast24h: 0, failedLast24h: 0, lastProcessedAt: null },
    synchronization: { lastRunAt: null, lastStatus: null, itemsReceived: 0, itemsSent: 0, itemsFailed: 0, errorCode: null, httpStatus: null, recentErrors: [], errorsLast24h: 0 },
    versions: { agent: '0.1.0', image: '0.1.0', application: '0.1.0', schema: '0002', postgres: '17.6' },
    backup: { lastStatus: 'succeeded', lastAt: at, lastSizeBytes: 120_000, retained: 1, lastError: null },
    certificates_security: { certificateSerial: 'a'.repeat(32), certificateNotAfter: new Date(Date.now() + 80 * 86_400_000).toISOString(), daysRemaining: 80, localAdminFailedLogins24h: 0, localAdminLocked: false, encryptedDiskConfirmed: null },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return { agentVersion: '0.1.0', reports: Object.entries(base).map(([type, payload]) => ({ schemaVersion: 1, type, observedAt: at, payload })) };
}
