import type { HealthEvaluation, HealthFinding, HealthPolicy, HealthState, LatestReport, ReportType } from '@psacc/contracts';

/**
 * The health rules engine. Pure: it derives a deployment's state from its latest reports, the last
 * heartbeat and the organization's policy. A heartbeat alone never makes a deployment healthy — the
 * database report must exist, be fresh and say the database is available.
 */
export interface EvaluationInput {
  now: Date;
  policy: HealthPolicy;
  lifecycleState: string;
  lastHeartbeatAt: Date | null;
  latest: Partial<{ [T in ReportType]: LatestReport<T> }>;
  /** The deployment's license as it applies today (Module 14); undefined for records without one. */
  license?: { code: string; status: string; daysRemaining: number | null } | null;
}

const pct = (used: number | null, total: number | null) => (used === null || total === null || total <= 0 ? null : Math.round((used / total) * 1000) / 10);
const ageSec = (now: Date, iso: string | null | undefined) => (iso ? Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000) : Infinity);
const hours = (s: number) => `${Math.round((s / 3600) * 10) / 10} h`;

export function evaluateHealth(input: EvaluationInput): HealthEvaluation {
  const { now, policy, latest } = input;
  const f: HealthFinding[] = [];
  const add = (severity: HealthFinding['severity'], code: string, message: string) => f.push({ code, severity, message });
  // Module 14: lifecycle and licensing are facts about the record, reported beside the measured health.
  if (input.lifecycleState === 'suspended') add('info', 'deployment_suspended', 'The deployment is suspended: PSA work on the appliance is paused until it is resumed.');
  // Module 15: a decommissioned deployment has no management identity any more; nothing is measured.
  if (input.lifecycleState === 'decommissioned') {
    add('info', 'deployment_decommissioned', 'The deployment is decommissioned: its appliance identity was retired and it no longer reports.');
    return { state: 'unknown', reason: 'Decommissioned', findings: f, evaluatedAt: now.toISOString() };
  }
  if (input.license === null) add('info', 'license_missing', 'No license is assigned to this deployment.');
  else if (input.license) {
    if (input.license.status !== 'active') add('degraded', 'license_inactive', `License ${input.license.code} is ${input.license.status}.`);
    else if (input.license.daysRemaining !== null && input.license.daysRemaining <= 30) {
      add('info', 'license_expiring', input.license.daysRemaining < 0 ? `License ${input.license.code} ended ${-input.license.daysRemaining} day(s) ago.` : `License ${input.license.code} ends in ${input.license.daysRemaining} day(s).`);
    }
  }
  const evaluatedAt = now.toISOString();
  const done = (state: HealthState, reason: string | null): HealthEvaluation => ({ state, reason, findings: f, evaluatedAt });

  // A suspended appliance that has enrolled keeps heartbeating and reporting (Module 14): it is evaluated like any other.
  const enrolledAppliance = ['enrolled', 'verified'].includes(input.lifecycleState) || (input.lifecycleState === 'suspended' && input.lastHeartbeatAt !== null);
  if (!enrolledAppliance) {
    add('info', 'not_enrolled', 'No agent has enrolled for this deployment.');
    return done('unknown', 'Not enrolled');
  }
  const heartbeatAge = input.lastHeartbeatAt ? (now.getTime() - input.lastHeartbeatAt.getTime()) / 1000 : Infinity;
  if (heartbeatAge > policy.offlineAfterSeconds) {
    const since = input.lastHeartbeatAt ? `last heartbeat ${hours(heartbeatAge)} ago` : 'no heartbeat received';
    add('critical', 'offline', `No heartbeat for more than ${policy.offlineAfterSeconds} s (${since}).`);
    return done('offline', `Offline: ${since}`);
  }

  const db = latest.database;
  if (!db) {
    add('info', 'no_reports', 'The agent has sent heartbeats but no database report yet.');
    return done('unknown', 'Awaiting the first agent reports');
  }
  if (ageSec(now, db.observedAt) > policy.staleReportAfterSeconds) {
    add('degraded', 'reports_stale', `The latest database report is ${hours(ageSec(now, db.observedAt))} old.`);
  }
  if (!db.payload.available) add('critical', 'database_unavailable', `PostgreSQL is not available${db.payload.error ? ` (${db.payload.error})` : ''}.`);
  else if (db.payload.error) add('degraded', 'database_report_error', `The database report is incomplete (${db.payload.error}).`);

  for (const s of latest.containers?.payload.services ?? []) {
    if (s.name === 'edge-agent') continue;
    if (s.state === 'down') add(s.name === 'edge-api' || s.name === 'edge-postgres' ? 'critical' : 'degraded', `${s.name.replace('-', '_')}_down`, `${s.name} is down${s.detail ? ` (${s.detail})` : ''}.`);
    else if (s.state === 'stale') add('degraded', `${s.name.replace('-', '_')}_stale`, `${s.name} has not reported recently${s.lastSeenAt ? ` (last seen ${hours(ageSec(now, s.lastSeenAt))} ago)` : ''}.`);
    else if (s.state === 'unknown') add('info', `${s.name.replace('-', '_')}_unknown`, `${s.name} could not be checked${s.detail ? ` (${s.detail})` : ''}.`);
  }

  const r = latest.host_resources?.payload;
  if (r) {
    const checks: [string, number | null, number, number][] = [
      ['cpu', r.cpuPercent, policy.cpuWarnPercent, policy.cpuCriticalPercent],
      ['memory', pct(r.memoryUsedBytes, r.memoryLimitBytes), policy.memoryWarnPercent, policy.memoryCriticalPercent],
      ['disk', pct(r.diskUsedBytes, r.diskTotalBytes), policy.diskWarnPercent, policy.diskCriticalPercent],
    ];
    for (const [name, value, warn, crit] of checks) {
      if (value === null) continue;
      if (value >= crit) add('critical', `${name}_critical`, `${name[0]!.toUpperCase() + name.slice(1)} usage is ${value}% (critical above ${crit}%).`);
      else if (value >= warn) add('degraded', `${name}_warn`, `${name[0]!.toUpperCase() + name.slice(1)} usage is ${value}% (warning above ${warn}%).`);
    }
  }

  const b = latest.backup?.payload;
  if (b) {
    if (b.lastStatus === 'failed') add('degraded', 'backup_failed', `The last backup failed${b.lastError ? `: ${b.lastError}` : '.'}`);
    else if (b.lastStatus === 'none' || !b.lastAt) add('info', 'backup_none', 'No backup has completed yet.');
    else if (ageSec(now, b.lastAt) > policy.backupMaxAgeHours * 3600) add('degraded', 'backup_old', `The last backup is ${hours(ageSec(now, b.lastAt))} old (limit ${policy.backupMaxAgeHours} h).`);
  }

  const c = latest.certificates_security?.payload;
  if (c) {
    if (c.daysRemaining < 0) add('critical', 'certificate_expired', 'The agent certificate has expired.');
    else if (c.daysRemaining <= policy.certificateWarnDays) add('degraded', 'certificate_expiring', `The agent certificate expires in ${c.daysRemaining} day(s).`);
    if (c.localAdminLocked) add('info', 'local_admin_locked', 'The local administrator account is locked after failed sign-ins.');
  }

  const p = latest.psa_integration_status?.payload;
  if (p) {
    if (p.status === 'failed') {
      const code = p.lastTestCode ?? p.lastTestResult;
      add('degraded', 'psa_failed', `The PSA connection test on the appliance failed${code ? ` (${code}${p.lastTestHttpStatus ? `, HTTP ${p.lastTestHttpStatus}` : ''})` : ''}.`);
    }
    else if (p.status === 'not_configured') add('info', 'psa_not_configured', 'PSA credentials have not been entered on the appliance.');
  }

  const s = latest.synchronization?.payload;
  if (s?.lastStatus === 'failed') add('degraded', 'sync_failed', `The last synchronization failed${s.errorCode ? ` (${s.errorCode})` : ''}.`);
  else if (s?.lastStatus === 'partial') add('info', 'sync_partial', `The last synchronization was partial${s.errorCode ? ` (${s.errorCode})` : ''}: ${s.itemsFailed} item(s) could not be pushed.`);
  const tm = latest.ticket_processing_metrics?.payload;
  if (tm?.conflictsLast24h) add('info', 'sync_conflicts', `${tm.conflictsLast24h} synchronization conflict(s) in the last 24 hours (the PSA's status won).`);

  if (f.some((x) => x.severity === 'critical')) return done('critical', f.filter((x) => x.severity === 'critical').map((x) => x.message).join(' '));
  if (f.some((x) => x.severity === 'degraded')) return done('degraded', f.filter((x) => x.severity === 'degraded').map((x) => x.message).join(' '));
  return done('healthy', null);
}

export const usage = pct;
