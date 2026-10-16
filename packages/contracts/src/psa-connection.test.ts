import { describe, expect, it } from 'vitest';
import { PSA_TEST_CODE_LABELS, PSA_TEST_CODES, psaIntegrationReportSchema, synchronizationReportSchema, ticketMetricsReportSchema } from './health.js';
import { integrationListQuerySchema } from './psa/schema.js';

const base = { provider: 'autotask', instanceCode: 'PSA-00001', status: 'credentials_present', credentialFields: 3, credentialsPresent: 3, lastTestAt: null, lastTestResult: null, apiCallsImplemented: false };

describe('PSA connection test reports (Module 11)', () => {
  it('accepts the pre-Module-11 report shape and the extended one; every code has a label', () => {
    expect(psaIntegrationReportSchema.safeParse(base).success).toBe(true);
    const full = psaIntegrationReportSchema.safeParse({
      ...base, status: 'verified', apiCallsImplemented: true, lastTestAt: '2026-10-15T10:00:00.000Z', lastTestResult: 'ok', lastTestCode: 'ok', lastTestHttpStatus: 200, lastTestLatencyMs: 412,
      lastTestedBy: 'local_admin', lastSuccessAt: '2026-10-15T10:00:00.000Z', remoteIdentity: { api: 'Autotask REST v1.0', host: 'webservices5.autotask.net' }, consecutiveFailures: 0, testsLast24h: 3, failedTestsLast24h: 1,
    });
    expect(full.success).toBe(true);
    for (const c of PSA_TEST_CODES) expect(PSA_TEST_CODE_LABELS[c]).toBeTruthy();
  });

  it('refuses unknown codes, unknown testers, bodies or free text that could carry secrets', () => {
    expect(psaIntegrationReportSchema.safeParse({ ...base, lastTestCode: 'exploded' }).success).toBe(false);
    expect(psaIntegrationReportSchema.safeParse({ ...base, lastTestedBy: 'root' }).success).toBe(false);
    expect(psaIntegrationReportSchema.safeParse({ ...base, lastTestHttpStatus: 42 }).success).toBe(false);
    expect(psaIntegrationReportSchema.safeParse({ ...base, responseBody: '{"token":"x"}' }).success).toBe(false); // strict: no extra fields
    expect(psaIntegrationReportSchema.safeParse({ ...base, remoteIdentity: { api: 'x'.repeat(201) } }).success).toBe(false);
    expect(psaIntegrationReportSchema.safeParse({ ...base, remoteIdentity: { nested: { a: 1 } } }).success).toBe(false);
  });

  it('synchronization and ticket metrics reports accept the Module 12 counters and stay counts-only', () => {
    const sync = { lastRunAt: '2026-10-15T10:00:00.000Z', lastStatus: 'partial', itemsReceived: 12, itemsSent: 1, itemsFailed: 1, errorCode: 'push_failed', httpStatus: null, recentErrors: [], errorsLast24h: 1 };
    expect(synchronizationReportSchema.safeParse(sync).success).toBe(true);
    expect(synchronizationReportSchema.safeParse({ ...sync, implemented: true, lastSucceededAt: null, runsLast24h: 3, failedRunsLast24h: 1, watermark: '2026-10-15T09:55:00.000Z' }).success).toBe(true);
    expect(synchronizationReportSchema.safeParse({ ...sync, tickets: [{ title: 'secret' }] }).success).toBe(false); // no content, ever
    const tm = { ticketsTotal: 40, ticketsOpen: 7, eventsLast24h: 15, failedLast24h: 0, lastProcessedAt: null };
    expect(ticketMetricsReportSchema.safeParse({ ...tm, pendingOutbound: 2, conflictsLast24h: 1, localOnly: 0, pushFailed: 0 }).success).toBe(true);
    expect(ticketMetricsReportSchema.safeParse({ ...tm, pendingOutbound: -1 }).success).toBe(false);
  });

  it('integration list query: provider, connection and credential filters are enumerated', () => {
    expect(integrationListQuerySchema.safeParse({ provider: 'connectwise', connectionStatus: 'failed', credentialStatus: 'invalid', live: '1' }).success).toBe(true);
    expect(integrationListQuerySchema.safeParse({ provider: 'jira' }).success).toBe(false);
    expect(integrationListQuerySchema.safeParse({ connectionStatus: 'verified' }).success).toBe(false);
  });
});
