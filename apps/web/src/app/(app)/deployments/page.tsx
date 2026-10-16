import { type DeploymentStats, type DeploymentSummary, LIFECYCLE_LABELS, type Paged, TARGET_ENVIRONMENTS } from '@psacc/contracts';
import { Funnel, Plus, Rocket } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PackageStatusBadge } from '@/components/deployments/badges';
import { HealthPill, LifecycleStage, SyntheticBadge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Pagination, SortTh, Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, relativeTime } from '@/lib/format';
import { hrefWith, pickParams } from '@/lib/query';
import { ENVIRONMENT_LABEL } from '@/lib/reference';

export const metadata: Metadata = { title: 'Deployments' };

const KEYS = ['q', 'lifecycle', 'health', 'environment', 'clientId', 'page', 'sort'] as const;
const selectClass = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm';
const STAGES = ['draft', 'package_generated', 'package_downloaded', 'enrolled', 'verified', 'suspended', 'decommissioned'] as const;

export default async function DeploymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'deployments.read')) notFound();
  const params = pickParams(await searchParams, KEYS);
  const [result, stats] = await Promise.all([
    apiGet<Paged<DeploymentSummary>>(hrefWith('/deployments', params, { pageSize: 20 })),
    apiGet<DeploymentStats>('/deployments/stats'),
  ]);
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/deployments', params, c);
  const filtered = KEYS.some((k) => k !== 'page' && k !== 'sort' && params[k]);
  const tz = me.user.timezone;

  const filter = (id: (typeof KEYS)[number], label: string, options: { value: string; label: string }[]) => (
    <div className="min-w-36 flex-1 sm:flex-none">
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-slate-500">{label}</label>
      <select id={id} name={id} defaultValue={params[id] ?? ''} className={selectClass}>
        <option value="">Any</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Deployments"
        description="One PSA Edge appliance per deployment, running in the client’s own Docker environment with its own database. Each stage below is shown only when there is evidence for it: a download is not an installation."
        actions={can(me, 'deployments.write') ? <ButtonLink href="/deployments/new" variant="primary"><Plus /> New deployment</ButtonLink> : null}
      />

      {stats.ok ? (
        <nav aria-label="Lifecycle stages" className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
          {STAGES.map((s) => (
            <Link
              key={s}
              href={href({ lifecycle: params.lifecycle === s ? undefined : s, page: undefined })}
              aria-current={params.lifecycle === s ? 'true' : undefined}
              className={`rounded-xl border bg-white px-4 py-3 transition-shadow hover:shadow-card ${params.lifecycle === s ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}
            >
              <p className="text-2xl font-semibold tabular-nums text-slate-900" data-testid={`stage-${s}`}>{stats.data[s]}</p>
              <p className="text-[12.5px] font-medium text-slate-500">{LIFECYCLE_LABELS[s]}</p>
            </Link>
          ))}
        </nav>
      ) : null}

      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter deployments">
          <div className="min-w-56 flex-[2]">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Deployment, client, host or PSA code" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          {filter('lifecycle', 'Lifecycle', Object.entries(LIFECYCLE_LABELS).map(([value, label]) => ({ value, label })))}
          {filter('health', 'Health', ['healthy', 'degraded', 'critical', 'offline', 'unknown'].map((h) => ({ value: h, label: h[0]!.toUpperCase() + h.slice(1) })))}
          {filter('environment', 'Environment', TARGET_ENVIRONMENTS.map((t) => ({ value: t.key, label: t.label })))}
          {params.clientId ? <input type="hidden" name="clientId" value={params.clientId} /> : null}
          {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {filtered ? <Link href="/deployments" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>
        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : result.data.items.length === 0 ? (
          <EmptyState icon={<Rocket />} title={filtered ? 'No deployments match these filters' : 'No deployments yet'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <SortTh field="code" label="Deployment" current={params.sort ?? 'code:desc'} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="client" label="Client" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <Th>PSA</Th>
                  <Th>Target</Th>
                  <SortTh field="lifecycle" label="Lifecycle" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="health" label="Health" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <Th>Last heartbeat</Th>
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((d) => (
                  <Tr key={d.id}>
                    <Td>
                      <Link href={`/deployments/${d.id}`} className="group block min-w-40">
                        <span className="block font-mono text-[13px] font-semibold text-blue-700 group-hover:underline">{d.code}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">
                          {d.hostLabel ?? null}
                          {d.isSynthetic ? <SyntheticBadge /> : null}
                        </span>
                      </Link>
                    </Td>
                    <Td className="text-[13px]"><Link href={`/clients/${d.client.id}`} className="hover:text-blue-700">{d.client.displayName}</Link></Td>
                    <Td className="text-[13px]">{d.psaInstance ? <>{d.psaInstance.providerName}<span className="block font-mono text-[12px] text-slate-500">{d.psaInstance.code}</span></> : '—'}</Td>
                    <Td className="text-[13px]">{ENVIRONMENT_LABEL[d.targetEnvironment] ?? d.targetEnvironment}<span className="block font-mono text-[12px] text-slate-500">{[d.targetOs, d.targetArch].filter(Boolean).join(' / ')}</span></Td>
                    <Td>
                      <LifecycleStage state={d.lifecycleState} />
                      {d.activePackage ? <span className="mt-1 block"><PackageStatusBadge status={d.activePackage.status} /></span> : null}
                    </Td>
                    <Td><HealthPill state={d.healthState} /></Td>
                    <Td className="whitespace-nowrap text-[13px] text-slate-600">
                      {d.isSynthetic ? <span className="italic text-slate-500">Synthetic — not live</span> : d.lastHeartbeatAt ? <span title={formatDateTime(d.lastHeartbeatAt, tz)}>{relativeTime(d.lastHeartbeatAt)}</span> : 'Never'}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} hrefFor={(p) => href({ page: p })} label="deployments" />
          </>
        )}
      </Card>
    </>
  );
}
