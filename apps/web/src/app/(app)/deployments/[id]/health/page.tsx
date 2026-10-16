import type { DeploymentHealthDto } from '@psacc/contracts';
import { Activity, CircleAlert, Database, HeartPulse, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PendingReports } from '@/components/deployments/pending-reports';
import { ResourceChart } from '@/components/health/resource-chart';
import { UsageBar } from '@/components/health/usage-bar';
import { ReportNowButton } from '@/components/deployments/report-now-button';
import { RefreshButton } from '@/components/refresh-button';
import { Alert } from '@/components/ui/alert';
import { Badge, HealthPill } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatBytes, getDeployment } from '@/lib/deployments';
import { formatDateTime, relativeTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Deployment health' };

const SERVICE_TONE: Record<string, 'emerald' | 'red' | 'amber' | 'neutral'> = { up: 'emerald', down: 'red', stale: 'amber', unknown: 'neutral' };
const pct = (used: number | null, total: number | null) => (used === null || total === null || total <= 0 ? null : Math.round((used / total) * 1000) / 10);

export default async function DeploymentHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'health.read')) notFound();
  const { id } = await params;
  const d = await getDeployment(id);
  const tz = me.user.timezone;
  if (d.isSynthetic) {
    return <PendingReports title="Health" icon={<HeartPulse />} module={8} reason="This is a synthetic sample record; no appliance reports for it exist." items={['Evaluated health state and findings', 'Resource utilisation from host_resources reports', 'Heartbeat history and health timeline', 'Service checks, backup, certificate and PSA status']} />;
  }
  const r = await apiGet<DeploymentHealthDto>(`/deployments/${id}/health`);
  if (!r.ok) return <Card><ErrorState problem={r.problem} /></Card>;
  const h = r.data;
  const res = h.latest.host_resources?.payload;
  const db = h.latest.database?.payload;
  const svc = h.latest.containers?.payload.services ?? [];
  const sync = h.latest.synchronization?.payload;
  const backup = h.latest.backup?.payload;
  const cert = h.latest.certificates_security?.payload;
  const psa = h.latest.psa_integration_status?.payload;
  const tickets = h.latest.ticket_processing_metrics?.payload;
  // A suspended appliance that enrolled keeps reporting (Module 14).
  const notEnrolled = !['enrolled', 'verified'].includes(h.lifecycleState) && !(h.lifecycleState === 'suspended' && h.lastHeartbeatAt);

  return (
    <div className="space-y-4">
      {h.lifecycleState === 'decommissioned' ? (
        <Alert variant="warning" title="The deployment is decommissioned">Its appliance identity was retired, so nothing is measured any more. The findings below state that; retained reports are purged by the retention policy.</Alert>
      ) : notEnrolled ? (
        <Alert variant="info" title="No agent has enrolled yet">Health is evaluated only from reports sent by the installed agent over its secure channel. Nothing is assumed from the package or a download.</Alert>
      ) : null}
      <Card>
        <CardHeader
          title="Health scorecard"
          icon={<HeartPulse />}
          description={h.evaluatedAt ? `Evaluated ${formatDateTime(h.evaluatedAt, tz, { seconds: true })} against the policy (offline after ${h.policy.offlineAfterSeconds} s, reports stale after ${h.policy.staleReportAfterSeconds} s).` : 'Not evaluated yet.'}
          actions={<span className="inline-flex flex-wrap items-center gap-2">{!notEnrolled && can(me, 'deployments.commands.issue') ? <ReportNowButton deploymentId={id} /> : null}<RefreshButton /></span>}
        />
        <CardBody className="pt-1">
          <div className="flex flex-wrap items-center gap-3">
            <HealthPill state={h.healthState} className="h-8 px-3 text-sm" />
            {h.healthReason ? <p className="text-sm text-slate-700" data-testid="health-reason">{h.healthReason}</p> : h.healthState === 'healthy' ? <p className="text-sm text-slate-700">All checks passed.</p> : null}
          </div>
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-slate-500">Agent</dt><dd className="font-medium text-slate-800">{notEnrolled ? 'Not enrolled' : h.lastHeartbeatAt && Date.now() - new Date(h.lastHeartbeatAt).getTime() < h.policy.offlineAfterSeconds * 1000 ? 'Online' : 'Offline'}{h.agentVersion ? <span className="ml-1 font-mono text-[12px] text-slate-500">{h.agentVersion}</span> : null}</dd></div>
            <div><dt className="text-slate-500">Last heartbeat</dt><dd className="font-medium text-slate-800">{h.lastHeartbeatAt ? `${formatDateTime(h.lastHeartbeatAt, tz, { seconds: true })} (${relativeTime(h.lastHeartbeatAt)})` : 'Never'}</dd></div>
            <div><dt className="text-slate-500">Enrolled</dt><dd className="font-medium text-slate-800">{h.enrolledAt ? formatDateTime(h.enrolledAt, tz) : '—'}</dd></div>
            <div><dt className="text-slate-500">Verified</dt><dd className="font-medium text-slate-800">{h.verifiedAt ? formatDateTime(h.verifiedAt, tz) : <span className="font-normal text-slate-500">Not yet — needs a healthy evaluation</span>}</dd></div>
          </dl>
          {h.findings.length ? (
            <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200" aria-label="Findings">
              {h.findings.map((f) => (
                <li key={f.code} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
                  <Badge tone={f.severity === 'critical' ? 'red' : f.severity === 'degraded' ? 'amber' : 'neutral'}>{f.severity}</Badge>
                  <span className="text-slate-700">{f.message} <span className="font-mono text-[11.5px] text-slate-400">{f.code}</span></span>
                </li>
              ))}
            </ul>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Resource utilisation" icon={<Activity />} description={res ? `Measured by the agent at ${formatDateTime(h.latest.host_resources!.observedAt, tz, { seconds: true })}.` : 'No host_resources report received yet.'} />
          <CardBody className="pt-1">
            {res ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <UsageBar label="CPU" value={res.cpuPercent} warn={h.policy.cpuWarnPercent} critical={h.policy.cpuCriticalPercent} />
                <UsageBar label="Memory" value={pct(res.memoryUsedBytes, res.memoryLimitBytes)} warn={h.policy.memoryWarnPercent} critical={h.policy.memoryCriticalPercent} />
                <UsageBar label="Disk" value={pct(res.diskUsedBytes, res.diskTotalBytes)} warn={h.policy.diskWarnPercent} critical={h.policy.diskCriticalPercent} />
              </div>
            ) : null}
            {res ? (
              <DetailRows rows={[
                ['Memory', res.memoryUsedBytes !== null && res.memoryLimitBytes !== null ? `${formatBytes(res.memoryUsedBytes)} of ${formatBytes(res.memoryLimitBytes)} (container limit)` : null],
                ['Disk', res.diskUsedBytes !== null && res.diskTotalBytes !== null ? `${formatBytes(res.diskUsedBytes)} of ${formatBytes(res.diskTotalBytes)} on ${res.diskMount}` : null],
                ['CPUs', res.cpuCount],
                ['Host uptime', res.uptimeSeconds !== null ? `${Math.floor(res.uptimeSeconds / 3600)} h ${Math.floor((res.uptimeSeconds % 3600) / 60)} min` : null],
              ]} />
            ) : null}
            <div className="mt-4"><ResourceChart samples={h.resourceHistory} policy={h.policy} timezone={tz} /></div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Database" icon={<Database />} description={db ? `Reported ${relativeTime(h.latest.database!.observedAt)} by the catalog-only inspector role.` : 'No database report received yet.'} />
          <CardBody className="pt-1">
            {db ? (
              <DetailRows rows={[
                ['Connection', db.available ? <span key="a" className="text-emerald-700">Available</span> : <span key="a" className="text-red-700">Unavailable{db.error ? ` (${db.error})` : ''}</span>],
                ['PostgreSQL', db.serverVersion ?? null],
                ['Schema version', db.schemaVersion ? <span key="s" className="font-mono">{db.schemaVersion}</span> : null],
                ['Migrations applied', db.migrationsApplied],
                ['Last migration', db.lastMigratedAt ? formatDateTime(db.lastMigratedAt, tz) : null],
                ['Size', formatBytes(db.sizeBytes)],
                ['Tables', `${db.tables.length} (Database tab for the inventory)`],
              ]} />
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Service checks" description="What the agent can probe from inside the deployment: it has no Docker socket." />
          <CardBody className="pt-1">
            {svc.length ? (
              <ul className="divide-y divide-slate-100">
                {svc.map((s) => (
                  <li key={s.name} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                    <span className="font-mono font-semibold text-slate-900">{s.name}</span>
                    <span className="flex items-center gap-2 text-slate-500">via {s.probe}{s.detail ? ` · ${s.detail}` : ''}{s.lastSeenAt ? ` · seen ${relativeTime(s.lastSeenAt)}` : ''}<Badge tone={SERVICE_TONE[s.state] ?? 'neutral'}>{s.state}</Badge></span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No service report received yet.</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Integration, backup and security" icon={<ShieldCheck />} />
          <CardBody className="pt-1">
            <DetailRows rows={[
              ['PSA connector', psa ? `${psa.status.replace('_', ' ')} · ${psa.credentialsPresent}/${psa.credentialFields} credentials · ${psa.apiCallsImplemented ? 'API calls enabled' : 'no API calls in this version'}` : null],
              ['Last backup', backup ? backup.lastStatus === 'none' ? 'None yet' : `${backup.lastStatus}${backup.lastAt ? ` · ${formatDateTime(backup.lastAt, tz)}` : ''}${backup.lastSizeBytes ? ` · ${formatBytes(backup.lastSizeBytes)}` : ''} · ${backup.retained} retained` : null],
              ['Agent certificate', cert ? `${cert.daysRemaining} days remaining (until ${formatDateTime(cert.certificateNotAfter, tz)})` : null],
              ['License token (verified by the appliance)', cert?.license ? `${cert.license.state}${cert.license.tokenExpiresAt ? ` · until ${formatDateTime(cert.license.tokenExpiresAt, tz)}` : ''} · key ${cert.license.keyId ?? 'none'} (${cert.license.keySource})${cert.license.psaWorkAllowed ? '' : ' · PSA work stopped'}` : null],
              ['Local admin', cert ? `${cert.localAdminFailedLogins24h} failed sign-ins in 24 h${cert.localAdminLocked ? ' · locked' : ''}` : null],
              ['Encrypted host disk', cert ? (cert.encryptedDiskConfirmed === null ? 'Cannot be confirmed from inside a container' : cert.encryptedDiskConfirmed ? 'Confirmed' : 'Not confirmed') : null],
              ['Synchronization', sync ? sync.lastStatus ? `${sync.lastStatus} · ${formatDateTime(sync.lastRunAt, tz)}` : 'No sync runs (Module 12)' : null],
            ]} />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Health timeline" description="State changes, newest first (30 days)." />
          <CardBody className="pt-1">
            {h.events.length ? (
              <ol className="relative space-y-3 border-l border-slate-200 pl-5">
                {h.events.map((e, i) => (
                  <li key={`${e.observedAt}-${i}`} className="relative">
                    <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full bg-white ring-2 ring-slate-300" aria-hidden="true" />
                    <div className="flex flex-wrap items-center gap-2"><HealthPill state={e.healthState} /><span className="text-[12.5px] text-slate-500">{formatDateTime(e.observedAt, tz, { seconds: true })} · {e.source}</span></div>
                    {e.reason ? <p className="mt-0.5 text-[13px] text-slate-600">{e.reason}</p> : null}
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-slate-500">No state changes recorded yet.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent heartbeats" description="Newest first (last 50, kept 7 days)." />
          <CardBody className="pt-1">
            {h.heartbeats.length ? (
              <ul className="max-h-72 divide-y divide-slate-100 overflow-auto text-[13px]">
                {h.heartbeats.map((b) => <li key={b.receivedAt} className="flex justify-between py-1.5"><span className="text-slate-700">{formatDateTime(b.receivedAt, tz, { seconds: true })}</span><span className="font-mono text-[12px] text-slate-500">{b.agentVersion}</span></li>)}
              </ul>
            ) : <p className="text-sm text-slate-500">No heartbeats received.</p>}
          </CardBody>
        </Card>
      </div>

      <Card data-testid="tickets-sync-card">
        <CardHeader title="Tickets & synchronization" description="Counts and statuses reported by the appliance, whose own database holds the tickets. No ticket content is transferred." />
        <CardBody className="pt-1">
          {tickets || sync ? (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">Tickets</dt><dd className="mt-0.5 text-slate-800 tabular-nums">{tickets ? `${tickets.ticketsOpen} open of ${tickets.ticketsTotal}` : '—'}</dd></div>
              <div><dt className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">Last synchronization</dt><dd className="mt-0.5 text-slate-800">{sync?.lastStatus ? `${sync.lastStatus} · ${formatDateTime(sync.lastRunAt, tz)}` : sync && sync.implemented === false ? 'Not implemented by this agent version' : 'No run yet'}</dd></div>
              <div><dt className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">Last run</dt><dd className="mt-0.5 text-slate-800 tabular-nums">{sync ? `${sync.itemsReceived} received · ${sync.itemsSent} sent · ${sync.itemsFailed} failed${sync.errorCode ? ` · ${sync.errorCode}` : ''}` : '—'}</dd></div>
              <div><dt className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">Waiting / conflicts</dt><dd className="mt-0.5 text-slate-800 tabular-nums">{tickets ? `${tickets.pendingOutbound ?? 0} change(s) waiting to push · ${tickets.conflictsLast24h ?? 0} conflict(s) in 24 h` : '—'}</dd></div>
              {sync?.runsLast24h != null ? <div><dt className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">Runs in 24 h</dt><dd className="mt-0.5 text-slate-800 tabular-nums">{sync.runsLast24h}{sync.failedRunsLast24h ? ` (${sync.failedRunsLast24h} failed)` : ''}</dd></div> : null}
              {sync?.lastSucceededAt ? <div><dt className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">Last success</dt><dd className="mt-0.5 text-slate-800">{formatDateTime(sync.lastSucceededAt, tz)}</dd></div> : null}
            </dl>
          ) : <p className="text-sm text-slate-500">No ticket or synchronization report received yet.</p>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Latest errors" icon={<CircleAlert />} description="Sanitized integration errors reported by the agent (codes and redacted messages; never ticket content)." />
        <CardBody className="pt-1">
          {sync?.recentErrors.length ? (
            <ul className="divide-y divide-slate-100 text-[13px]">
              {sync.recentErrors.map((e, i) => <li key={`${e.at}-${i}`} className="py-2"><span className="text-slate-500">{formatDateTime(e.at, tz, { seconds: true })} · {e.component}{e.code ? ` · ${e.code}` : ''}{e.httpStatus ? ` · HTTP ${e.httpStatus}` : ''}</span><span className="block text-slate-800">{e.message}</span></li>)}
            </ul>
          ) : <p className="text-sm text-slate-500">{sync ? `No errors reported${sync.errorsLast24h ? '' : ' in the last 24 hours'}.` : 'No synchronization report received yet.'}</p>}
        </CardBody>
      </Card>
    </div>
  );
}
