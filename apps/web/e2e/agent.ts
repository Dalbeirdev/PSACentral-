/** Acts as an edge agent against the E2E stack's gateway: enroll a fresh deployment and send reports. */
import { webcrypto } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { Page } from '@playwright/test';
import * as x509 from '@peculiar/x509';
import { unzipSync } from 'fflate';
import { expect } from '@playwright/test';
import { csrfHeaders } from './fixtures';
import { E2E_BASE_URL, E2E_GATEWAY_PORT } from './env';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export interface E2EAgent { id: string; code: string; installationId: string; serial: string; keyPem: string; certPem: string; ca: string }

function call(path: string, body: unknown, ca: string, agent?: { keyPem: string; certPem: string }) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpsRequest({ host: '127.0.0.1', port: E2E_GATEWAY_PORT, path, method: 'POST', ca, key: agent?.keyPem, cert: agent?.certPem, headers: { 'content-type': 'application/json' } }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => resolve({ status: r.statusCode!, body: JSON.parse(b || '{}') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** Module 14: packages and enrollment need an active license with capacity; the E2E stack creates a large one per client once. */
export async function ensureLicense(page: Page, clientId: string): Promise<void> {
  const existing = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/licenses?clientId=${clientId}&status=active&pageSize=50`)).json()).items as { displayName: string; deploymentsUsed: number; maxDeployments: number }[];
  if (existing.some((l) => l.displayName === 'E2E capacity' && l.deploymentsUsed < l.maxDeployments)) return;
  const r = await page.request.post(`${E2E_BASE_URL}/api/v1/licenses`, { data: { clientId, displayName: 'E2E capacity', startsAt: new Date().toISOString().slice(0, 10), endsAt: null, maxDeployments: 1000 }, headers: await csrfHeaders(page) });
  expect(r.status()).toBe(201);
}

export async function enrolledDeployment(page: Page, clientQuery = 'Lumen'): Promise<E2EAgent> {
  const client = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/clients?q=${encodeURIComponent(clientQuery)}`)).json()).items[0];
  const psa = (await (await page.request.get(`${E2E_BASE_URL}/api/v1/psa-instances?clientId=${client.id}&status=active`)).json()).items[0];
  const headers = await csrfHeaders(page);
  await ensureLicense(page, client.id);
  const dep = await (await page.request.post(`${E2E_BASE_URL}/api/v1/deployments`, { data: { clientId: client.id, psaInstanceId: psa.id, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64' }, headers })).json();
  const pkg = (await (await page.request.post(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}/packages`, { data: { tokenValidityHours: 1 }, headers })).json()).currentPackage;
  const zip = await (await page.request.post(`${E2E_BASE_URL}/api/v1/deployments/${dep.id}/packages/${pkg.id}/download`, { headers })).body();
  const en = JSON.parse(Buffer.from(unzipSync(new Uint8Array(zip))[`psacc-${dep.code.toLowerCase()}/enrollment/enrollment.json`]!).toString());
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${en.installationId}`, keys, signingAlgorithm: ALG });
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  const res = await call('/agent/v1/enroll', { token: en.token, deploymentId: en.deploymentId, installationId: en.installationId, csr: csr.toString('pem'), agentVersion: '0.1.0' }, en.caCertificate);
  expect(res.status).toBe(201);
  return { id: dep.id, code: dep.code, installationId: en.installationId as string, serial: res.body.serial as string, keyPem, certPem: res.body.certificate as string, ca: en.caCertificate };
}

export function reports(over: Partial<Record<string, Record<string, unknown>>> = {}) {
  const at = new Date().toISOString();
  const base: Record<string, Record<string, unknown>> = {
    database: { available: true, serverVersion: '17.6', schemaVersion: '0002', migrationsApplied: 2, lastMigratedAt: at, sizeBytes: 8_500_000, tables: [{ schema: 'public', name: 'helpdesk_tickets', estimatedRows: 0, sizeBytes: 40960, columns: 17, hasPrimaryKey: true, indexes: 4, foreignKeys: 1 }] },
    host_resources: { cpuPercent: 23.4, memoryUsedBytes: 400_000_000, memoryLimitBytes: 2_000_000_000, diskUsedBytes: 55_000_000_000, diskTotalBytes: 100_000_000_000, diskMount: 'docker-volumes', uptimeSeconds: 7200, cpuCount: 4 },
    containers: { services: [{ name: 'edge-postgres', probe: 'database', state: 'up' }, { name: 'edge-api', probe: 'http', state: 'up' }, { name: 'edge-worker', probe: 'liveness', state: 'up', lastSeenAt: at }, { name: 'edge-backup', probe: 'liveness', state: 'up' }, { name: 'edge-agent', probe: 'self', state: 'up' }] },
    psa_integration_status: { provider: 'autotask', instanceCode: 'PSA-00011', status: 'credentials_present', credentialFields: 3, credentialsPresent: 3, lastTestAt: null, lastTestResult: null, apiCallsImplemented: false },
    ticket_processing_metrics: { ticketsTotal: 0, ticketsOpen: 0, eventsLast24h: 0, failedLast24h: 0, lastProcessedAt: null },
    synchronization: { lastRunAt: null, lastStatus: null, itemsReceived: 0, itemsSent: 0, itemsFailed: 0, errorCode: null, httpStatus: null, recentErrors: [{ at, component: 'worker', code: 'psa_not_configured', httpStatus: null, message: 'PSA credentials not entered yet (redacted message example)' }], errorsLast24h: 1 },
    versions: { agent: '0.1.0', image: '0.1.0', application: '0.1.0', schema: '0002', postgres: '17.6' },
    backup: { lastStatus: 'succeeded', lastAt: at, lastSizeBytes: 120_000, retained: 1, lastError: null },
    certificates_security: { certificateSerial: 'a'.repeat(32), certificateNotAfter: new Date(Date.now() + 80 * 86_400_000).toISOString(), daysRemaining: 80, localAdminFailedLogins24h: 0, localAdminLocked: false, encryptedDiskConfirmed: null },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k], ...v };
  return { agentVersion: '0.1.0', reports: Object.entries(base).map(([type, payload]) => ({ schemaVersion: 1, type, observedAt: at, payload })) };
}

export async function sendReports(a: E2EAgent, body: unknown) {
  return call('/agent/v1/reports', body, a.ca, a);
}

/** Module 13: a heartbeat returns open signed commands; results are answered over the same mTLS channel. */
/** Module 17: the client deletes the deployment from the appliance (the local administrator confirmed there). */
export async function deleteFromAppliance(a: E2EAgent, requestedBy = 'localadmin', reason = 'Contract ended') {
  return call('/agent/v1/delete', { installationId: a.installationId, requestedBy, reason, requestedAt: new Date().toISOString() }, a.ca, a);
}

export async function heartbeat(a: E2EAgent) {
  return call('/agent/v1/heartbeat', { agentVersion: '0.1.0', observedAt: new Date().toISOString() }, a.ca, a);
}

export async function commandResult(a: E2EAgent, commandId: string, over: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return call('/agent/v1/command-results', { commandId, status: 'succeeded', code: 'reports_delivered', message: '1 batch delivered', startedAt: now, finishedAt: now, agentVersion: '0.1.0', ...over }, a.ca, a);
}

/** A one-part database_schema snapshot for the tables of reports().database, as the agent sends it. */
export function schemaSnapshot(fingerprint = 'b'.repeat(32)) {
  const at = new Date().toISOString();
  const col = (position: number, name: string, type: string, nullable = false, def: string | null = null) => ({ position, name, type, nullable, default: def, identity: false });
  const tables = [
    {
      schema: 'public', name: 'helpdesk_tickets', kind: 'table',
      columns: [col(1, 'id', 'uuid', false, 'gen_random_uuid()'), col(2, 'psa_connection_id', 'uuid'), col(3, 'subject', 'text'), col(4, 'status', 'text', false, "'open'::text"), col(5, 'created_at', 'timestamp with time zone', false, 'now()')],
      primaryKey: { name: 'helpdesk_tickets_pkey', columns: ['id'] },
      indexes: [
        { name: 'helpdesk_tickets_pkey', unique: true, primary: true, definition: 'CREATE UNIQUE INDEX helpdesk_tickets_pkey ON public.helpdesk_tickets USING btree (id)', sizeBytes: 8192 },
        { name: 'helpdesk_tickets_status_idx', unique: false, primary: false, definition: 'CREATE INDEX helpdesk_tickets_status_idx ON public.helpdesk_tickets USING btree (status)', sizeBytes: 8192 },
      ],
      foreignKeys: [{ name: 'helpdesk_tickets_psa_connection_id_fkey', columns: ['psa_connection_id'], referencedSchema: 'public', referencedTable: 'psa_connections', referencedColumns: ['id'], onDelete: 'restrict' }],
      stats: { estimatedRows: 0, liveRows: 0, deadRows: 0, lastAnalyzeAt: null, lastAutoanalyzeAt: null, lastVacuumAt: null, lastAutovacuumAt: null, totalBytes: 40960, tableBytes: 8192, indexBytes: 16384, toastBytes: 0 },
    },
  ];
  return { agentVersion: '0.1.0', reports: [{ schemaVersion: 1, type: 'database_schema', observedAt: at, payload: { fingerprint, part: 1, parts: 1, tables } }] };
}
