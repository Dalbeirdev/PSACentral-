import type { LicenseStats, LicenseSummary, Paged } from '@psacc/contracts';
import { LICENSE_STATUS_LABELS, LICENSE_STATUSES } from '@psacc/contracts';
import { Funnel, KeyRound, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LicenseStatusBadge, TermBadge } from '@/components/licenses/license-bits';
import { Badge, SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Pagination, SortTh, Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatCalendarDate } from '@/lib/format';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'Licenses' };

const KEYS = ['q', 'status', 'expiringWithinDays', 'clientId', 'page', 'sort'] as const;
const selectClass = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm';

/** Licenses (Module 14): per-client entitlements with their own identifier, term and deployment limit. */
export default async function LicensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  const params = pickParams(await searchParams, KEYS);
  const [result, stats] = await Promise.all([apiGet<Paged<LicenseSummary>>(hrefWith('/licenses', params, {})), apiGet<LicenseStats>('/licenses/stats')]);
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/licenses', params, c);
  const filtered = KEYS.filter((k) => k !== 'page' && k !== 'sort').some((k) => params[k]);
  const canManage = can(me, 'licenses.manage');
  const s = stats.ok ? stats.data : null;
  const cards: { key: string; label: string; value: number; href: Record<string, string | undefined>; active: boolean }[] = s
    ? [
        { key: 'all', label: 'All licenses', value: s.total, href: { status: undefined, expiringWithinDays: undefined, page: undefined }, active: !params.status && !params.expiringWithinDays },
        { key: 'active', label: 'Active', value: s.active, href: { status: 'active', expiringWithinDays: undefined, page: undefined }, active: params.status === 'active' && !params.expiringWithinDays },
        { key: 'expiring', label: 'Expiring within 30 days', value: s.expiring, href: { status: undefined, expiringWithinDays: '30', page: undefined }, active: params.expiringWithinDays === '30' },
        { key: 'suspended', label: 'Suspended', value: s.suspended, href: { status: 'suspended', expiringWithinDays: undefined, page: undefined }, active: params.status === 'suspended' },
        { key: 'expired', label: 'Expired / revoked', value: s.expired + s.revoked, href: { status: 'expired', expiringWithinDays: undefined, page: undefined }, active: params.status === 'expired' || params.status === 'revoked' },
      ]
    : [];

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Licenses' }]}
        title="Licenses"
        description="Entitlements per client: a plan, a term and how many appliances may run under it. A deployment needs an active license with free capacity to get a package or to enroll; expiry is checked every hour and flagged on the deployment's health."
        actions={canManage ? <ButtonLink href="/licenses/new" data-testid="new-license"><Plus /> New license</ButtonLink> : undefined}
      />
      {cards.length ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="license-stats">
          {cards.map((c) => (
            <Link key={c.key} href={href(c.href)} aria-current={c.active ? 'true' : undefined} className={`rounded-xl border bg-white px-4 py-3 transition-shadow hover:shadow-card ${c.active ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}>
              <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">{c.label}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{c.value}</p>
            </Link>
          ))}
        </div>
      ) : null}
      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-4 py-3" aria-label="Filter licenses">
          <label className="grid gap-1 text-[12.5px] font-medium text-slate-600">
            Search
            <input name="q" defaultValue={params.q ?? ''} placeholder="License ID, plan or client" className="h-9 w-64 rounded-lg border border-slate-200 bg-white px-3 text-sm" />
          </label>
          <label className="grid gap-1 text-[12.5px] font-medium text-slate-600">
            Status
            <select name="status" defaultValue={params.status ?? ''} className={selectClass}>
              <option value="">Any</option>
              {LICENSE_STATUSES.map((st) => <option key={st} value={st}>{LICENSE_STATUS_LABELS[st]}</option>)}
            </select>
          </label>
          {params.clientId ? <input type="hidden" name="clientId" value={params.clientId} /> : null}
          {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
          <button type="submit" className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"><Funnel className="mr-1 inline size-4" aria-hidden="true" />Apply</button>
          {filtered ? <Link href="/licenses" className="text-sm font-medium text-blue-700 underline">Clear</Link> : null}
        </form>
        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : result.data.items.length === 0 ? (
          <EmptyState icon={<KeyRound />} title={filtered ? 'No license matches these filters' : 'No licenses yet'} description={filtered ? 'Change or clear the filters.' : canManage ? 'Create the first license for a client.' : 'Licenses are created by license managers.'} action={canManage && !filtered ? <ButtonLink href="/licenses/new"><Plus /> New license</ButtonLink> : undefined} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table data-testid="licenses-table">
                <thead>
                  <tr>
                    <SortTh field="code" label="License" current={params.sort} hrefFor={(x) => href({ sort: x, page: undefined })} />
                    <SortTh field="client" label="Client" current={params.sort} hrefFor={(x) => href({ sort: x, page: undefined })} />
                    <Th>Plan</Th>
                    <SortTh field="status" label="Status" current={params.sort} hrefFor={(x) => href({ sort: x, page: undefined })} />
                    <SortTh field="endsAt" label="Term" current={params.sort} hrefFor={(x) => href({ sort: x, page: undefined })} />
                    <Th>Deployments</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((l) => (
                    <Tr key={l.id} data-testid="license-row">
                      <Td>
                        <Link href={`/licenses/${l.id}`} className="font-mono text-[12.5px] font-semibold text-blue-700 hover:underline">{l.code}</Link>
                        {l.isSynthetic ? <SyntheticBadge className="ml-2" /> : null}
                      </Td>
                      <Td><Link href={`/clients/${l.client.id}`} className="text-slate-800 hover:underline">{l.client.displayName}</Link> <span className="font-mono text-[12px] text-slate-500">{l.client.code}</span></Td>
                      <Td className="text-slate-800">{l.displayName}</Td>
                      <Td><LicenseStatusBadge status={l.status} /></Td>
                      <Td>
                        <span className="block text-slate-800">{formatCalendarDate(l.startsAt)} → {l.endsAt ? formatCalendarDate(l.endsAt) : 'no end'}</span>
                        <TermBadge l={l} />
                      </Td>
                      <Td>
                        <span className="font-medium text-slate-900">{l.deploymentsUsed} of {l.maxDeployments}</span>
                        {l.deploymentsUsed >= l.maxDeployments ? <Badge tone="amber" className="ml-2">full</Badge> : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
            <Pagination page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} hrefFor={(p) => href({ page: p })} label="licenses" />
          </>
        )}
      </Card>
    </>
  );
}
