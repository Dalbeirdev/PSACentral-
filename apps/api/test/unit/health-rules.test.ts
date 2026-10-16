import { DEFAULT_HEALTH_POLICY, type LatestReport, type ReportType } from '@psacc/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateHealth } from '../../src/modules/health/rules.js';

const now = new Date('2026-10-14T12:00:00Z');
const ago = (sec: number) => new Date(now.getTime() - sec * 1000);
const report = <T extends ReportType>(type: T, payload: LatestReport<T>['payload'], ageSec = 10): LatestReport<T> =>
  ({ type, observedAt: ago(ageSec).toISOString(), receivedAt: ago(ageSec).toISOString(), payload }) as LatestReport<T>;
const db = (over: Partial<LatestReport<'database'>['payload']> = {}, ageSec = 10) =>
  report('database', { available: true, migrationsApplied: 1, sizeBytes: 8_000_000, tables: [], ...over }, ageSec);
const base = { now, policy: DEFAULT_HEALTH_POLICY, lifecycleState: 'enrolled', lastHeartbeatAt: ago(10) };

describe('health rules engine', () => {
  it('a deployment that has not enrolled is unknown', () => {
    const e = evaluateHealth({ ...base, lifecycleState: 'package_downloaded', lastHeartbeatAt: null, latest: {} });
    expect(e).toMatchObject({ state: 'unknown', reason: 'Not enrolled' });
  });

  it('a heartbeat alone never makes a deployment healthy', () => {
    const e = evaluateHealth({ ...base, latest: {} });
    expect(e.state).toBe('unknown');
    expect(e.findings.map((f) => f.code)).toEqual(['no_reports']);
  });

  it('goes offline when the heartbeat is older than the policy threshold, regardless of reports', () => {
    const e = evaluateHealth({ ...base, lastHeartbeatAt: ago(DEFAULT_HEALTH_POLICY.offlineAfterSeconds + 1), latest: { database: db() } });
    expect(e.state).toBe('offline');
    expect(e.reason).toMatch(/Offline: last heartbeat/);
    expect(evaluateHealth({ ...base, lastHeartbeatAt: null, latest: { database: db() } }).reason).toBe('Offline: no heartbeat received');
  });

  it('is healthy only with a fresh database report that says the database is available', () => {
    expect(evaluateHealth({ ...base, latest: { database: db() } })).toMatchObject({ state: 'healthy', reason: null, findings: [] });
    expect(evaluateHealth({ ...base, latest: { database: db({ available: false, error: 'database_unavailable' }) } })).toMatchObject({ state: 'critical', reason: 'PostgreSQL is not available (database_unavailable).' });
    const stale = evaluateHealth({ ...base, latest: { database: db({}, DEFAULT_HEALTH_POLICY.staleReportAfterSeconds + 60) } });
    expect(stale.state).toBe('degraded');
    expect(stale.findings[0]!.code).toBe('reports_stale');
  });

  it('resource thresholds: warning → degraded, critical → critical; unmeasured values are ignored', () => {
    const res = (cpu: number | null, memUsed: number | null, diskUsed: number | null) =>
      report('host_resources', { cpuPercent: cpu, memoryUsedBytes: memUsed, memoryLimitBytes: 1000, diskUsedBytes: diskUsed, diskTotalBytes: 1000, diskMount: '/var/log/psa-edge', uptimeSeconds: 100, cpuCount: 2 });
    expect(evaluateHealth({ ...base, latest: { database: db(), host_resources: res(85, 100, 100) } })).toMatchObject({ state: 'degraded', reason: 'Cpu usage is 85% (warning above 80%).' });
    expect(evaluateHealth({ ...base, latest: { database: db(), host_resources: res(10, 960, 100) } }).state).toBe('critical');
    expect(evaluateHealth({ ...base, latest: { database: db(), host_resources: res(10, 100, 850) } }).findings.map((f) => f.code)).toEqual(['disk_warn']);
    expect(evaluateHealth({ ...base, latest: { database: db(), host_resources: res(null, null, null) } }).state).toBe('healthy');
  });

  it('service checks: edge-api or the database down is critical; a stale worker is degraded; the agent itself is ignored', () => {
    const svc = (name: 'edge-api' | 'edge-worker' | 'edge-agent', state: 'up' | 'down' | 'stale') =>
      report('containers', { services: [{ name, probe: 'http', state, detail: state === 'down' ? 'connection_refused' : undefined }] });
    expect(evaluateHealth({ ...base, latest: { database: db(), containers: svc('edge-api', 'down') } })).toMatchObject({ state: 'critical', reason: 'edge-api is down (connection_refused).' });
    expect(evaluateHealth({ ...base, latest: { database: db(), containers: svc('edge-worker', 'stale') } }).state).toBe('degraded');
    expect(evaluateHealth({ ...base, latest: { database: db(), containers: svc('edge-agent', 'down') } }).state).toBe('healthy');
  });

  it('backups, certificates, PSA and sync feed degraded; info findings never change the state', () => {
    const latest = {
      database: db(),
      backup: report('backup', { lastStatus: 'succeeded', lastAt: ago(3 * 86_400).toISOString(), lastSizeBytes: 1000, retained: 7, lastError: null }),
      certificates_security: report('certificates_security', { certificateSerial: 'a'.repeat(32), certificateNotAfter: now.toISOString(), daysRemaining: 5, localAdminFailedLogins24h: 0, localAdminLocked: true, encryptedDiskConfirmed: null }),
      psa_integration_status: report('psa_integration_status', { provider: 'autotask', instanceCode: 'PSA-00001', status: 'not_configured', credentialFields: 3, credentialsPresent: 0, lastTestAt: null, lastTestResult: null, apiCallsImplemented: false }),
    };
    const e = evaluateHealth({ ...base, latest });
    expect(e.state).toBe('degraded');
    expect(e.findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['degraded:backup_old', 'degraded:certificate_expiring', 'info:local_admin_locked', 'info:psa_not_configured']);
    const expired = { ...latest, certificates_security: { ...latest.certificates_security, payload: { ...latest.certificates_security.payload, daysRemaining: -1 } } };
    expect(evaluateHealth({ ...base, latest: expired }).state).toBe('critical');
    const infoOnly = { database: db(), backup: report('backup', { lastStatus: 'none', lastAt: null, lastSizeBytes: null, retained: 0, lastError: null }) };
    expect(evaluateHealth({ ...base, latest: infoOnly })).toMatchObject({ state: 'healthy', findings: [{ code: 'backup_none', severity: 'info' }] });
  });

  it('synchronization outcomes: failed degrades, partial and conflicts are informational (Module 12)', () => {
    const sync = (over: Record<string, unknown>) => report('synchronization', { lastRunAt: now.toISOString(), lastStatus: 'succeeded', itemsReceived: 12, itemsSent: 2, itemsFailed: 0, errorCode: null, httpStatus: null, recentErrors: [], errorsLast24h: 0, implemented: true, lastSucceededAt: now.toISOString(), runsLast24h: 10, failedRunsLast24h: 0, watermark: now.toISOString(), ...over });
    const tickets = (over: Record<string, unknown>) => report('ticket_processing_metrics', { ticketsTotal: 40, ticketsOpen: 7, eventsLast24h: 15, failedLast24h: 0, lastProcessedAt: now.toISOString(), pendingOutbound: 0, conflictsLast24h: 0, localOnly: 0, pushFailed: 0, ...over });
    expect(evaluateHealth({ ...base, latest: { database: db(), synchronization: sync({}), ticket_processing_metrics: tickets({}) } })).toMatchObject({ state: 'healthy', findings: [] });
    const partial = evaluateHealth({ ...base, latest: { database: db(), synchronization: sync({ lastStatus: 'partial', itemsFailed: 2, errorCode: 'push_failed' }), ticket_processing_metrics: tickets({ conflictsLast24h: 1 }) } });
    expect(partial.state).toBe('healthy');
    expect(partial.findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['info:sync_partial', 'info:sync_conflicts']);
    const failed = evaluateHealth({ ...base, latest: { database: db(), synchronization: sync({ lastStatus: 'failed', errorCode: 'auth_failed' }) } });
    expect(failed).toMatchObject({ state: 'degraded', findings: [{ code: 'sync_failed', severity: 'degraded', message: 'The last synchronization failed (auth_failed).' }] });
  });

  it('lifecycle and licensing are facts beside the measured health: suspension and expiring licenses inform, an inactive license degrades (Module 14)', () => {
    const ok = evaluateHealth({ ...base, latest: { database: db() }, license: { code: 'LIC-00007', status: 'active', daysRemaining: 200 } });
    expect(ok).toMatchObject({ state: 'healthy', findings: [] });
    const suspended = evaluateHealth({ ...base, lifecycleState: 'suspended', latest: { database: db() }, license: { code: 'LIC-00007', status: 'active', daysRemaining: 12 } });
    expect(suspended.state).toBe('healthy');
    expect(suspended.findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['info:deployment_suspended', 'info:license_expiring']);
    expect(suspended.findings[1]!.message).toBe('License LIC-00007 ends in 12 day(s).');
    const expired = evaluateHealth({ ...base, latest: { database: db() }, license: { code: 'LIC-00007', status: 'expired', daysRemaining: -3 } });
    expect(expired).toMatchObject({ state: 'degraded', findings: [{ code: 'license_inactive', severity: 'degraded', message: 'License LIC-00007 is expired.' }] });
    const none = evaluateHealth({ ...base, latest: { database: db() }, license: null });
    expect(none.findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['info:license_missing']);
    expect(evaluateHealth({ ...base, latest: { database: db() } }).findings).toEqual([]); // records from before licensing: nothing invented
  });

  it('a decommissioned deployment is unknown with a single finding, whatever reports it once sent (Module 15)', () => {
    const r = evaluateHealth({ ...base, lifecycleState: 'decommissioned', latest: { database: db() }, license: { code: 'LIC-00007', status: 'active', daysRemaining: 200 } });
    expect(r).toMatchObject({ state: 'unknown', reason: 'Decommissioned' });
    expect(r.findings.map((f) => `${f.severity}:${f.code}`)).toEqual(['info:deployment_decommissioned']);
  });

  it('a failed PSA connection test on the appliance is a degraded finding naming the code and HTTP status (Module 11)', () => {
    const failed = report('psa_integration_status', {
      provider: 'connectwise', instanceCode: 'PSA-00002', status: 'failed', credentialFields: 3, credentialsPresent: 3, lastTestAt: now.toISOString(), lastTestResult: 'auth_failed',
      apiCallsImplemented: true, lastTestCode: 'auth_failed', lastTestHttpStatus: 401, lastTestLatencyMs: 230, lastTestedBy: 'worker', lastSuccessAt: null, consecutiveFailures: 3,
    });
    const e = evaluateHealth({ ...base, latest: { database: db(), psa_integration_status: failed } });
    expect(e.state).toBe('degraded');
    expect(e.findings).toEqual([{ severity: 'degraded', code: 'psa_failed', message: 'The PSA connection test on the appliance failed (auth_failed, HTTP 401).' }]);
    const verified = report('psa_integration_status', { ...failed.payload, status: 'verified', lastTestCode: 'ok', lastTestHttpStatus: 200, lastSuccessAt: now.toISOString(), consecutiveFailures: 0 });
    expect(evaluateHealth({ ...base, latest: { database: db(), psa_integration_status: verified } })).toMatchObject({ state: 'healthy', findings: [] });
  });
});
