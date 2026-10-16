import type { ClientSummary, OnboardingDraftSummary, Paged, UserRef } from '@psacc/contracts';
import { PSA_PROVIDER_CATALOG } from '@psacc/contracts';
import { Building, Funnel, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ClientStatusBadge, HealthBar } from '@/components/clients/badges';
import { SyntheticBadge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Pagination, SortTh, Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatCalendarDate, relativeTime } from '@/lib/format';
import { hrefWith, pickParams } from '@/lib/query';
import { CLIENT_STATUS_LABEL, COUNTRY_OPTIONS, countryName, SERVICE_STATUS_LABEL } from '@/lib/reference';
import { HEALTH_LABELS, HEALTH_ORDER } from '@/lib/health';

export const metadata: Metadata = { title: 'Clients' };

const KEYS = ['q', 'status', 'serviceStatus', 'country', 'provider', 'health', 'accountManager', 'page', 'sort'] as const;
const selectClass = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm';

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  const params = pickParams(await searchParams, KEYS);
  const writer = can(me, 'clients.write');
  const [result, users, drafts] = await Promise.all([
    apiGet<Paged<ClientSummary>>(hrefWith('/clients', params, { pageSize: 20 })),
    apiGet<UserRef[]>('/directory/users'),
    writer ? apiGet<OnboardingDraftSummary[]>('/onboarding/drafts') : Promise.resolve(null),
  ]);
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/clients', params, c);
  const filtered = KEYS.some((k) => k !== 'page' && k !== 'sort' && params[k]);

  const filter = (id: string, label: string, options: { value: string; label: string }[]) => (
    <div className="min-w-36 flex-1 sm:flex-none">
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-slate-500">{label}</label>
      <select id={id} name={id} defaultValue={params[id as (typeof KEYS)[number]] ?? ''} className={selectClass}>
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Clients"
        description={me.clientScope === 'assigned_clients' ? 'Clients assigned to you.' : 'Every client in your organization, with PSA and deployment status at a glance.'}
        actions={
          writer ? (
            <ButtonLink href="/clients/new" variant="primary">
              <Plus /> Onboard client
            </ButtonLink>
          ) : null
        }
      />

      {drafts?.ok && drafts.data.length ? (
        <Card className="mb-4 border-blue-200/80 bg-gradient-to-r from-blue-50/80 to-white px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-700">
              <span className="font-semibold text-slate-900">{drafts.data.length} onboarding{drafts.data.length === 1 ? '' : 's'} in progress</span>
              {' · '}
              {drafts.data.slice(0, 3).map((d, i) => (
                <span key={d.id}>
                  {i ? ', ' : ''}
                  <Link className="font-medium text-blue-700 hover:underline" href={`/clients/new/${d.id}/${d.currentStep}`}>{d.clientName ?? 'Untitled draft'}</Link>
                  <span className="text-slate-500"> ({relativeTime(d.updatedAt)})</span>
                </span>
              ))}
            </p>
            <ButtonLink href="/clients/new" variant="secondary" size="sm">View all drafts</ButtonLink>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter clients">
          <div className="min-w-56 flex-[2]">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Name, legal name, reference, code or city" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          {filter('status', 'Status', Object.entries(CLIENT_STATUS_LABEL).map(([value, label]) => ({ value, label })))}
          {filter('serviceStatus', 'Service status', Object.entries(SERVICE_STATUS_LABEL).map(([value, label]) => ({ value, label })))}
          {filter('provider', 'PSA', PSA_PROVIDER_CATALOG.map((p) => ({ value: p.key, label: p.name })))}
          {filter('health', 'Deployment health', HEALTH_ORDER.map((s) => ({ value: s, label: HEALTH_LABELS[s] })))}
          {filter('country', 'Country', COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: c.name })))}
          {users.ok ? filter('accountManager', 'Account manager', users.data.map((u) => ({ value: u.id, label: u.displayName }))) : null}
          {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {filtered ? <Link href="/clients" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>

        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : result.data.items.length === 0 ? (
          <EmptyState
            icon={<Building />}
            title={filtered ? 'No clients match these filters' : 'No clients yet'}
            description={filtered ? 'Try a different search or clear the filters.' : writer ? 'Start the onboarding wizard to add your first client.' : undefined}
            action={!filtered && writer ? <ButtonLink href="/clients/new" variant="primary"><Plus /> Onboard client</ButtonLink> : undefined}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <SortTh field="displayName" label="Client" current={params.sort ?? 'displayName:asc'} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="clientReference" label="Reference" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="status" label="Status" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <Th>PSA</Th>
                  <Th>Deployments</Th>
                  <SortTh field="country" label="Location" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="onboardingDate" label="Onboarded" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((c) => (
                  <Tr key={c.id}>
                    <Td>
                      <Link href={`/clients/${c.id}`} className="group block">
                        <span className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900 group-hover:text-blue-700">{c.displayName}</span>
                          {c.isSynthetic ? <SyntheticBadge /> : null}
                        </span>
                        <span className="block text-[12.5px] text-slate-500">
                          <span className="font-mono">{c.code}</span> · {c.legalName}
                        </span>
                      </Link>
                    </Td>
                    <Td className="font-mono text-[12.5px]">{c.clientReference}</Td>
                    <Td><ClientStatusBadge status={c.status} /></Td>
                    <Td className="text-[13px]">{c.psaProviders.length ? c.psaProviders.map((p) => p.name).join(', ') : <span className="text-slate-500">—</span>}</Td>
                    <Td><HealthBar health={c.health} total={c.deploymentCount} /></Td>
                    <Td className="text-[13px]">
                      {countryName(c.countryCode)}
                      {c.city ? <span className="block text-[12.5px] text-slate-500">{c.city}</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-[13px] text-slate-600">{formatCalendarDate(c.onboardingDate)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} hrefFor={(p) => href({ page: p })} label="clients" />
          </>
        )}
      </Card>
    </>
  );
}
