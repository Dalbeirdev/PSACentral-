import type { FleetHealthDto } from '@psacc/contracts';
import { Funnel, HeartPulse, Settings2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { UsageBar } from '@/components/health/usage-bar';
import { RefreshButton } from '@/components/refresh-button';
import { Alert } from '@/components/ui/alert';
import { HealthPill, LifecycleStage, SyntheticBadge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, relativeTime } from '@/lib/format';
import { HEALTH_LABELS, HEALTH_ORDER } from '@/lib/health';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'Health Monitoring' };
const KEYS = ['state', 'q', 'live'] as const;

export default async function MonitoringPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'health.read')) notFound();
  const params = pickParams(await searchParams, KEYS);
  const r = await apiGet<FleetHealthDto>(hrefWith('/monitoring/fleet', params, {}));
  if (!r.ok) return <Card><ErrorState problem={r.problem} /></Card>;
  const f = r.data;
  const tz = me.user.timezone;
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/monitoring', params, c);
  const liveTotal = HEALTH_ORDER.reduce((n, s) => n + f.summary[s] - f.syntheticSummary[s], 0);
  const synthTotal = HEALTH_ORDER.reduce((n, s) => n + f.syntheticSummary[s], 0);

  return (
    <>
      <PageHeader
        title="Health Monitoring"
        description={`Evaluated from agent reports against the health policy (heartbeat every ${f.policy.heartbeatIntervalSeconds} s, offline after ${f.policy.offlineAfterSeconds} s). A heartbeat alone never counts as healthy.`}
        actions={<span className="flex gap-2"><RefreshButton />{can(me, 'settings.manage') ? <ButtonLink href="/settings/health" variant="secondary"><Settings2 /> Health policy</ButtonLink> : null}</span>}
      />
      {synthTotal > 0 && !params.live ? (
        <Alert variant="synthetic" title={`${synthTotal} of ${liveTotal + synthTotal} deployments are synthetic sample records`} className="mb-4" actions={<Link href={href({ live: '1' })} className="text-sm font-semibold underline">Show live only</Link>}>
          Their states come from development sample data, not from installed agents. The counts below separate them.
        </Alert>
      ) : null}

      <nav aria-label="Health states" className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {HEALTH_ORDER.map((s) => (
          <Link key={s} href={href({ state: params.state === s ? undefined : s })} aria-current={params.state === s ? 'true' : undefined}
            className={`rounded-xl border bg-white px-4 py-3 transition-shadow hover:shadow-card ${params.state === s ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}>
            <p className="text-2xl font-semibold tabular-nums text-slate-900" data-testid={`health-${s}`}>{params.live ? f.summary[s] : f.summary[s] - f.syntheticSummary[s]}</p>
            <p className="flex items-center justify-between text-[12.5px] font-medium text-slate-500"><HealthPill state={s} />{!params.live && f.syntheticSummary[s] ? <span className="text-amber-700">+{f.syntheticSummary[s]} synthetic</span> : null}</p>
          </Link>
        ))}
      </nav>

      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter deployments">
          <div className="min-w-56 flex-[2]">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Deployment or client" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          <label className="flex h-9 items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="live" value="1" defaultChecked={!!params.live} className="accent-blue-600" /> Live deployments only</label>
          {params.state ? <input type="hidden" name="state" value={params.state} /> : null}
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {params.q || params.live || params.state ? <Link href="/monitoring" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>
        {f.rows.length === 0 ? (
          <EmptyState icon={<HeartPulse />} title="No deployments match" />
        ) : (
          <Table>
            <thead>
              <tr><Th>Deployment</Th><Th>State</Th><Th>Reason</Th><Th>Heartbeat</Th><Th>Resources</Th><Th>Database</Th></tr>
            </thead>
            <tbody>
              {f.rows.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <Link href={`/deployments/${d.id}/health`} className="group block min-w-44">
                      <span className="block font-mono text-[13px] font-semibold text-blue-700 group-hover:underline">{d.code}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">{d.client.displayName}{d.isSynthetic ? <SyntheticBadge /> : null}</span>
                    </Link>
                  </Td>
                  <Td><HealthPill state={d.healthState} /><span className="mt-1 block"><LifecycleStage state={d.lifecycleState as never} /></span></Td>
                  <Td className="max-w-72 text-[12.5px] text-slate-600">{d.healthReason ?? (d.healthState === 'healthy' ? `All checks passed · ${HEALTH_LABELS.healthy}` : '—')}</Td>
                  <Td className="whitespace-nowrap text-[13px] text-slate-600">
                    {d.isSynthetic ? <span className="italic text-slate-500">Synthetic — not live</span> : d.lastHeartbeatAt ? <span title={formatDateTime(d.lastHeartbeatAt, tz)}>{relativeTime(d.lastHeartbeatAt)}</span> : 'Never'}
                    {d.agentVersion ? <span className="block font-mono text-[11.5px] text-slate-500">agent {d.agentVersion}</span> : null}
                  </Td>
                  <Td>
                    {d.isSynthetic ? <span className="text-[12.5px] italic text-slate-500">No measurements</span> : (
                      <div className="grid w-40 gap-1.5">
                        <UsageBar label="CPU" value={d.cpuPercent} warn={f.policy.cpuWarnPercent} critical={f.policy.cpuCriticalPercent} />
                        <UsageBar label="Memory" value={d.memoryPercent} warn={f.policy.memoryWarnPercent} critical={f.policy.memoryCriticalPercent} />
                        <UsageBar label="Disk" value={d.diskPercent} warn={f.policy.diskWarnPercent} critical={f.policy.diskCriticalPercent} />
                      </div>
                    )}
                  </Td>
                  <Td className="text-[13px]">
                    {d.isSynthetic ? <span className="italic text-slate-500">—</span> : d.databaseAvailable === null ? <span className="text-slate-500">No report</span> : d.databaseAvailable ? <span className="font-medium text-emerald-700">Available</span> : <span className="font-medium text-red-700">Unavailable</span>}
                    {d.lastReportAt ? <span className="block text-[11.5px] text-slate-500">reported {relativeTime(d.lastReportAt)}</span> : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-[12.5px] text-slate-500">Generated {formatDateTime(f.generatedAt, tz, { seconds: true })} · times in {tz}</p>
    </>
  );
}
