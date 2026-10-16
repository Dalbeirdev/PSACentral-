import type { AuditEventDto, Paged } from '@psacc/contracts';
import { Bot, Funnel, ScrollText, ServerCog, UserRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Pagination, SortTh, Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'Activity & audit logs' };

const KEYS = ['q', 'outcome', 'action', 'page', 'sort'] as const;
const ACTION_PRESETS = [
  { value: '', label: 'All activity' },
  { value: 'auth', label: 'Authentication' },
  { value: 'auth.login', label: 'Sign-ins' },
  { value: 'auth.mfa', label: 'Two-step verification' },
  { value: 'user', label: 'User administration' },
  { value: 'access.denied', label: 'Access denied' },
  { value: 'system', label: 'System' },
];

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'audit.read')) notFound();
  const params = pickParams(await searchParams, KEYS);
  const result = await apiGet<Paged<AuditEventDto>>(hrefWith('/audit-events', params, { pageSize: 25 }));
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/audit', params, c);
  const tz = me.user.timezone;
  const filtered = !!(params.q || params.outcome || params.action);

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Activity & audit logs' }]}
        title="Activity & audit logs"
        description="Append-only record of sign-ins, security changes, administrative actions and denied access. Entries cannot be edited or deleted, which the database enforces."
      />
      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter audit events">
          <div className="min-w-56 flex-1">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Actor, target or action" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          <div>
            <label htmlFor="action" className="mb-1.5 block text-xs font-medium text-slate-500">Category</label>
            <select id="action" name="action" defaultValue={params.action ?? ''} className="h-9 rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm">
              {ACTION_PRESETS.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="outcome" className="mb-1.5 block text-xs font-medium text-slate-500">Outcome</label>
            <select id="outcome" name="outcome" defaultValue={params.outcome ?? ''} className="h-9 rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm">
              <option value="">Any outcome</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </select>
          </div>
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {filtered ? <Link href="/audit" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>

        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : result.data.items.length === 0 ? (
          <EmptyState icon={<ScrollText />} title={filtered ? 'No events match these filters' : 'No audit events yet'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <SortTh field="occurredAt" label={`Time (${tz})`} current={params.sort ?? 'occurredAt:desc'} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="action" label="Action" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <SortTh field="actor" label="Actor" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <Th>Target</Th>
                  <SortTh field="outcome" label="Outcome" current={params.sort} hrefFor={(s) => href({ sort: s, page: undefined })} />
                  <Th>Source</Th>
                </tr>
              </thead>
              <tbody>
                {result.data.items.map((e) => (
                  <Tr key={e.id}>
                    <Td className="whitespace-nowrap text-[13px] text-slate-600 tnum">{formatDateTime(e.occurredAt, tz, { seconds: true })}</Td>
                    <Td>
                      <span className="font-mono text-[12.5px] text-slate-900">{e.action}</span>
                      {Object.keys(e.metadata).length ? (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-800">Details</summary>
                          <pre className="mt-1 max-w-md overflow-x-auto rounded-lg bg-slate-50 p-2 text-[11.5px] leading-4 text-slate-700 ring-1 ring-slate-200">{JSON.stringify(e.metadata, null, 2)}</pre>
                        </details>
                      ) : null}
                    </Td>
                    <Td>
                      <span className="flex items-center gap-2 text-[13px]">
                        {e.actorType === 'user' ? <UserRound className="size-4 text-slate-400" aria-hidden="true" /> : e.actorType === 'agent' ? <Bot className="size-4 text-slate-400" aria-hidden="true" /> : <ServerCog className="size-4 text-slate-400" aria-hidden="true" />}
                        <span className="max-w-56 truncate text-slate-800">{e.actorDisplay}</span>
                      </span>
                    </Td>
                    <Td className="max-w-64 truncate text-[13px] text-slate-600">{e.targetDisplay ?? e.targetId ?? '—'}</Td>
                    <Td>
                      <Badge tone={e.outcome === 'success' ? 'emerald' : e.outcome === 'denied' ? 'red' : 'amber'}>{e.outcome}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-[12px] text-slate-500">
                      {e.ip ?? '—'}
                      {e.requestId ? <span className="block max-w-36 truncate font-mono text-[11px] text-slate-500" title={e.requestId}>{e.requestId}</span> : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={result.data.page} pageSize={result.data.pageSize} total={result.data.total} hrefFor={(p) => href({ page: p })} label="events" />
          </>
        )}
      </Card>
    </>
  );
}
