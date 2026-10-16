import type { DashboardSummary, HealthState } from '@psacc/contracts';
import {
  Building,
  Container,
  HeartPulse,
  Plug,
  Rocket,
  ClockArrowUp,
  Siren,
  WifiOff,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { HealthDonut, OnboardingChart, StatusOverTimeChart } from '@/components/charts/charts';
import { HEALTH_COLORS, HEALTH_LABELS, HEALTH_ORDER } from '@/lib/health';
import { BarList, ChartCard } from '@/components/charts/chart-card';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { RefreshButton } from '@/components/refresh-button';
import { Alert } from '@/components/ui/alert';
import { HealthPill, LifecycleStage, SyntheticBadge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, formatTime, greeting, percent, relativeTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Overview' };

export default async function DashboardPage() {
  const me = await requireActiveSession();
  const tz = me.user.timezone;
  const result = await apiGet<DashboardSummary>('/dashboard/summary');
  const firstName = me.user.displayName.split(' ')[0];

  const header = (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
      <div>
        <p className="text-sm font-medium text-slate-500">{greeting(tz)}, {firstName}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] sm:leading-9">Operations overview</h1>
        <p className="mt-1.5 text-sm text-slate-500">
          {me.organization.name}
          {me.clientScope === 'assigned_clients' ? ' · showing your assigned clients only' : ''}
        </p>
      </div>
      <div className="flex items-center gap-3">
        {result.ok ? (
          <span className="text-xs text-slate-500" title={formatDateTime(result.data.generatedAt, tz, { seconds: true })}>
            Data as of {formatTime(result.data.generatedAt, tz)}
          </span>
        ) : null}
        <RefreshButton />
      </div>
    </div>
  );

  if (!result.ok) {
    return (
      <>
        {header}
        <Card>
          <ErrorState problem={result.problem} title="The overview could not be loaded" />
        </Card>
      </>
    );
  }

  const d = result.data;
  const k = d.kpis;
  const totalForDonut = d.healthDistribution.reduce((s, h) => s + h.count, 0);
  const anyTimeline = d.statusOverTime.some((day) => Object.entries(day).some(([key, v]) => key !== 'date' && Number(v) > 0));

  return (
    <>
      {header}

      {d.provenance.containsSynthetic ? (
        <Alert variant="synthetic" className="mb-6" title="Development sample data" role="status">
          {d.provenance.syntheticRecords} of {d.provenance.syntheticRecords + d.provenance.liveRecords} records on this page are synthetic and labeled{' '}
          <span className="font-medium">Synthetic</span>. They exist to exercise the dashboard and never represent a real client installation
          or live health status.
        </Alert>
      ) : null}

      <section aria-label="Key metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard testId="kpi-clients" href="/clients" label="Total clients" value={k.totalClients} tone="blue" icon={<Building />}
          context={<><span className="font-medium text-blue-700">+{k.newClientsLast30Days}</span> in the last 30 days</>} />
        <KpiCard testId="kpi-psa" href="/psa" label="PSA instances" value={k.totalPsaInstances} tone="violet" icon={<Plug />}
          context={`${k.psaProvidersInUse} provider${k.psaProvidersInUse === 1 ? '' : 's'} in use`} />
        <KpiCard testId="kpi-active" href="/deployments" label="Active deployments" value={k.activeDeployments} tone="cyan" icon={<Rocket />}
          context={`of ${k.totalDeployments} deployments · enrolled and reporting`} />
        <KpiCard testId="kpi-offline" href="/monitoring" label="Offline deployments" value={k.offlineDeployments} tone="slate" icon={<WifiOff />}
          context="No heartbeat within the offline threshold" />
        <KpiCard testId="kpi-healthy" href="/monitoring" label="Healthy installations" value={k.healthyInstallations} tone="emerald" icon={<HeartPulse />}
          meter={{ value: k.activeDeployments ? k.healthyInstallations / k.activeDeployments : 0, label: 'Healthy share of active deployments' }}
          context={`${percent(k.healthyInstallations, k.activeDeployments)} of active deployments`} />
        <KpiCard testId="kpi-critical" href="/notifications" label="Critical alerts" value={k.criticalAlerts} tone="red" icon={<Siren />}
          context={k.criticalAlerts ? <span className="font-medium text-red-700">Deployments in critical state</span> : 'No deployment is critical'} />
        <KpiCard testId="kpi-versions" href="/docker-images" label="Docker versions" value={k.dockerVersionsInUse} tone="blue" icon={<Container />}
          context={k.latestImageVersion ? <>Latest <span className="font-mono text-slate-700">{k.latestImageVersion}</span> · enrolled fleet</> : 'No image deployed yet'} />
        <KpiCard testId="kpi-recent" href="/deployments" label="Recent deployments" value={k.recentDeploymentsLast30Days} tone="amber" icon={<ClockArrowUp />}
          context="Created in the last 30 days" />
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <ChartCard
          className="xl:col-span-2"
          title="Installation status over time"
          description={`End-of-day health state per deployment · last 30 days (${tz})`}
          table={{
            columns: ['Date', ...HEALTH_ORDER.map((s) => HEALTH_LABELS[s])],
            rows: d.statusOverTime.map((r) => [r.date, r.healthy, r.degraded, r.critical, r.offline, r.unknown]),
          }}
        >
          {anyTimeline ? (
            <>
              <StatusOverTimeChart data={d.statusOverTime} />
              <Legend states={['healthy', 'degraded', 'critical', 'offline']} />
            </>
          ) : (
            <EmptyState title="No health history yet" description="The timeline fills in once enrolled agents report health (Module 8)." />
          )}
        </ChartCard>

        <ChartCard
          title="Deployment health"
          description="Current state of all deployments"
          table={{ columns: ['State', 'Deployments', 'Share'], rows: d.healthDistribution.map((h) => [HEALTH_LABELS[h.state], h.count, percent(h.count, totalForDonut)]) }}
        >
          {totalForDonut ? (
            <div className="flex flex-col items-center gap-5 sm:flex-row xl:flex-col 2xl:flex-row">
              <HealthDonut data={d.healthDistribution} total={totalForDonut} />
              <ul className="w-full space-y-2" aria-label="Deployment health breakdown">
                {d.healthDistribution.map((h) => (
                  <li key={h.state} className="flex items-center justify-between gap-3 text-[13px]">
                    <HealthPill state={h.state} />
                    <span className="tnum text-slate-500">
                      <span className="font-semibold text-slate-900">{h.count}</span> · {percent(h.count, totalForDonut)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState title="No deployments yet" description="Deployments appear here once they are created for a client." />
          )}
        </ChartCard>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <ChartCard
          title="Client onboarding"
          description="New clients per month · last 12 months"
          table={{ columns: ['Month', 'Clients onboarded'], rows: d.onboardingTrend.map((m) => [m.month, m.count]) }}
        >
          <OnboardingChart data={d.onboardingTrend} />
        </ChartCard>

        <ChartCard
          title="PSA provider distribution"
          description="PSA instances by provider"
          table={{ columns: ['Provider', 'Instances'], rows: d.psaProviderDistribution.map((p) => [p.name, p.count]) }}
        >
          <BarList
            ariaLabel="PSA instances per provider"
            items={d.psaProviderDistribution.map((p) => ({ key: p.provider, label: p.name, value: p.count }))}
            empty={<EmptyState title="No PSA instances yet" description="PSA instances are created in Module 3." />}
          />
        </ChartCard>

        <ChartCard
          title="Deployment version distribution"
          description="Edge image versions across the enrolled fleet"
          table={{ columns: ['Image version', 'Deployments'], rows: d.versionDistribution.map((v) => [v.version, v.count]) }}
        >
          <BarList
            ariaLabel="Deployments per image version"
            emphasize={k.latestImageVersion ?? undefined}
            items={[...d.versionDistribution].reverse().map((v) => ({
              key: v.version,
              label: (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px]">{v.version}</span>
                  {v.version === k.latestImageVersion ? <span className="rounded bg-blue-50 px-1.5 text-[11px] font-semibold text-blue-700">latest</span> : null}
                </span>
              ),
              value: v.count,
            }))}
            empty={<EmptyState title="No enrolled deployments" description="Versions are reported by enrolled agents." />}
          />
        </ChartCard>
      </div>

      <Card className="mt-4 overflow-hidden">
        <CardHeader title="Recent deployments" description="Most recently created deployment records" className="pb-4" />
        {d.recentDeployments.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Deployment</Th>
                <Th>PSA</Th>
                <Th>Image</Th>
                <Th>Lifecycle</Th>
                <Th>Health</Th>
                <Th>Last heartbeat</Th>
              </tr>
            </thead>
            <tbody>
              {d.recentDeployments.map((r) => (
                <Tr key={r.id}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Link href={`/deployments/${r.id}`} className="font-mono text-[13px] font-semibold text-blue-700 hover:underline">
                        {r.code}
                      </Link>
                      {r.isSynthetic ? <SyntheticBadge /> : null}
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-slate-500">{r.clientName}</p>
                  </Td>
                  <Td className="text-[13px]">{r.psaProviderName ?? <span className="text-slate-500">—</span>}</Td>
                  <Td className="font-mono text-[12.5px]">{r.imageVersion ?? <span className="text-slate-500">—</span>}</Td>
                  <Td>
                    <LifecycleStage state={r.lifecycleState} />
                  </Td>
                  <Td>
                    <HealthPill state={r.healthState} />
                  </Td>
                  <Td className="text-[13px] text-slate-500">
                    {r.isSynthetic ? (
                      <span className="italic text-slate-500" title="Synthetic records have no live heartbeat">Synthetic — not live</span>
                    ) : r.lastHeartbeatAt ? (
                      <span title={formatDateTime(r.lastHeartbeatAt, tz, { seconds: true })}>{relativeTime(r.lastHeartbeatAt)}</span>
                    ) : (
                      'Never'
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No deployments yet" description="Deployment records are created with the onboarding workflow (Modules 2–5)." />
        )}
      </Card>
    </>
  );
}

function Legend({ states }: { states: HealthState[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[12.5px] text-slate-600" aria-label="Legend">
      {states.map((s) => (
        <li key={s} className="flex items-center gap-2">
          <span className="h-2 w-3.5 rounded-sm" style={{ background: HEALTH_COLORS[s] }} aria-hidden="true" />
          {HEALTH_LABELS[s]}
        </li>
      ))}
    </ul>
  );
}
