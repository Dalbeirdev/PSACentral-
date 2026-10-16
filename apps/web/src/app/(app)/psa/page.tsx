import type { Paged, PsaInstanceSummary, PsaProviderDescriptor } from '@psacc/contracts';
import { Funnel, Plug, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ConnectionBadge, CredentialBadge, InstanceStatusBadge } from '@/components/psa/badges';
import { SyntheticBadge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Pagination, SortTh, Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'PSA Management' };

const KEYS = ['q', 'provider', 'connectionStatus', 'credentialStatus', 'status', 'page', 'sort'] as const;
const selectClass = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm';

export default async function PsaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  const params = pickParams(await searchParams, KEYS);
  const [result, providers] = await Promise.all([
    apiGet<Paged<PsaInstanceSummary>>(hrefWith('/psa-instances', params, { pageSize: 20 })),
    apiGet<PsaProviderDescriptor[]>('/psa-providers'),
  ]);
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/psa', params, c);
  const filtered = KEYS.some((k) => k !== 'page' && k !== 'sort' && params[k]);
  const providerList = providers.ok ? providers.data : [];

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
        title="PSA Management"
        description="Every client PSA instance, its configuration and its connection state. Connectivity shows as verified only after the client's appliance reports a real test; PSA APIs are never called from the control plane."
        actions={can(me, 'psa.write') ? <ButtonLink href="/psa/new" variant="primary"><Plus /> New PSA instance</ButtonLink> : null}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {providerList.map((p) => (
          <Link key={p.key} href={href({ provider: p.key, page: undefined })} className={`rounded-xl border bg-white px-3.5 py-3 transition-shadow hover:shadow-card ${params.provider === p.key ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}>
            <p className="truncate text-[13px] font-semibold text-slate-900">{p.name}</p>
            <p className="truncate text-[12px] text-slate-500">{p.vendor}</p>
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter PSA instances">
          <div className="min-w-56 flex-[2]">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Instance, code, client or endpoint" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          {filter('provider', 'Provider', providerList.map((p) => ({ value: p.key, label: p.name })))}
          {filter('connectionStatus', 'Connection', [{ value: 'untested', label: 'Untested' }, { value: 'succeeded', label: 'Verified' }, { value: 'failed', label: 'Test failed' }])}
          {filter('credentialStatus', 'Credentials', [{ value: 'pending_appliance', label: 'Pending on appliance' }, { value: 'not_configured', label: 'Not configured' }, { value: 'configured', label: 'Configured' }, { value: 'invalid', label: 'Invalid' }, { value: 'expired', label: 'Expired' }])}
          {filter('status', 'Status', [{ value: 'active', label: 'Active' }, { value: 'disabled', label: 'Disabled' }])}
          {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {filtered ? <Link href="/psa" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>
        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : result.data.items.length === 0 ? (
          <EmptyState icon={<Plug />} title={filtered ? 'No PSA instances match these filters' : 'No PSA instances yet'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <SortTh field="code" label="Instance" current={params.sort ?? 'code:asc'} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="client" label="Client" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="provider" label="Provider" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <Th>Connection</Th>
                  <Th>Credentials</Th>
                  <Th>Usage</Th>
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((i) => (
                  <Tr key={i.id}>
                    <Td>
                      <Link href={`/psa/${i.id}`} className="group block min-w-52">
                        <span className="block font-semibold text-slate-900 group-hover:text-blue-700">{i.displayName}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">
                          <span className="font-mono">{i.code}</span>
                          {i.isSynthetic ? <SyntheticBadge /> : null}
                          {i.status === 'disabled' ? <InstanceStatusBadge status="disabled" /> : null}
                        </span>
                      </Link>
                    </Td>
                    <Td className="text-[13px]"><Link href={`/clients/${i.client.id}`} className="hover:text-blue-700">{i.client.displayName}</Link></Td>
                    <Td className="text-[13px]">{i.providerName}<span className="block max-w-64 truncate font-mono text-[11.5px] text-slate-500" title={i.apiEndpoint ?? undefined}>{i.apiEndpoint}</span></Td>
                    <Td><ConnectionBadge status={i.connectionStatus} /></Td>
                    <Td><CredentialBadge status={i.credentialStatus} /></Td>
                    <Td className="whitespace-nowrap text-[13px] text-slate-600">{i.deploymentCount} deployment{i.deploymentCount === 1 ? '' : 's'} · {i.enabledServiceCount} service{i.enabledServiceCount === 1 ? '' : 's'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} hrefFor={(p) => href({ page: p })} label="instances" />
          </>
        )}
      </Card>
    </>
  );
}
