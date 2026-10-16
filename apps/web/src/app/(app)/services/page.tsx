import type { ServiceCategoryDto, ServiceSummary } from '@psacc/contracts';
import { INTEGRATION_DEPENDENCIES } from '@psacc/contracts';
import { Funnel, LayoutList, Plus, Tags } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DefaultBadge, DependencyChip, ServiceStatusBadge, UsesPsaBadge } from '@/components/services/badges';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'Service Catalog' };

const KEYS = ['q', 'category', 'status', 'dependency', 'usesPsa'] as const;
const selectClass = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm';

export default async function ServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  const params = pickParams(await searchParams, KEYS);
  const [result, categories] = await Promise.all([
    apiGet<ServiceSummary[]>(hrefWith('/services', params, {})),
    apiGet<ServiceCategoryDto[]>('/service-categories'),
  ]);
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/services', params, c);
  const filtered = KEYS.some((k) => params[k]);
  const cats = categories.ok ? categories.data : [];
  const canWrite = can(me, 'services.write');

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
        title="Service Catalog"
        description="The services this organization provides, as stored in the database: categories, defaults for new clients, what each service needs from the client’s PSA and which settings a client must supply. Assignments are made per client; the selection is included in each deployment’s configuration."
        actions={
          <span className="flex flex-wrap gap-2">
            <ButtonLink href="/services/categories" variant="secondary"><Tags /> Categories</ButtonLink>
            {canWrite ? <ButtonLink href="/services/new" variant="primary"><Plus /> New service</ButtonLink> : null}
          </span>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {cats.map((c) => (
          <Link key={c.id} href={href({ category: params.category === c.key ? undefined : c.key })} className={`rounded-xl border bg-white px-3.5 py-3 transition-shadow hover:shadow-card ${params.category === c.key ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}>
            <p className="truncate text-[13px] font-semibold text-slate-900">{c.name}</p>
            <p className="text-[12px] text-slate-500">{c.activeServiceCount} active{c.serviceCount !== c.activeServiceCount ? ` · ${c.serviceCount - c.activeServiceCount} inactive` : ''}</p>
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter services">
          <div className="min-w-56 flex-[2]">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Name, key or description" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          {filter('category', 'Category', cats.map((c) => ({ value: c.key, label: c.name })))}
          {filter('status', 'Status', [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }])}
          {filter('usesPsa', 'PSA', [{ value: '1', label: 'Uses the PSA' }, { value: '0', label: 'Independent of the PSA' }])}
          {filter('dependency', 'Dependency', INTEGRATION_DEPENDENCIES.map((d) => ({ value: d.key, label: d.label })))}
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {filtered ? <Link href="/services" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>
        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : result.data.length === 0 ? (
          <EmptyState icon={<LayoutList />} title={filtered ? 'No services match these filters' : 'The catalog is empty'} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Service</Th>
                <Th>Category</Th>
                <Th>Dependencies</Th>
                <Th>Settings</Th>
                <Th>Clients</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <Link href={`/services/${s.id}`} className="group block min-w-56">
                      <span className="block font-semibold text-slate-900 group-hover:text-blue-700">{s.name}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">
                        <span className="font-mono">{s.key}</span>
                        {s.isDefault ? <DefaultBadge compact /> : null}
                        {s.requiresPsa ? <UsesPsaBadge compact /> : null}
                      </span>
                    </Link>
                  </Td>
                  <Td className="text-[13px] text-slate-700">{s.category.name}</Td>
                  <Td>
                    {s.integrationDependencies.length ? (
                      <span className="flex max-w-72 flex-wrap gap-1">{s.integrationDependencies.map((d) => <DependencyChip key={d} dep={d} />)}</span>
                    ) : <span className="text-[13px] text-slate-500">None</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-[13px] text-slate-600">
                    {s.configRequirements.length ? `${s.configRequirements.length} setting${s.configRequirements.length === 1 ? '' : 's'}${s.configRequirements.some((r) => r.required) ? ` (${s.configRequirements.filter((r) => r.required).length} required)` : ''}` : '—'}
                  </Td>
                  <Td className="whitespace-nowrap text-[13px] text-slate-600">{s.clientCount} client{s.clientCount === 1 ? '' : 's'}</Td>
                  <Td><ServiceStatusBadge active={s.isActive} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
