import type { AuditEventDto, Paged } from '@psacc/contracts';
import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Pagination, Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Client activity' };

export default async function ClientActivityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const r = await apiGet<Paged<AuditEventDto>>(`/clients/${id}/activity?page=${page}&pageSize=25`);
  const tz = me.user.timezone;
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Activity history" description="Every recorded change to this client, its contacts, services, PSA instances and deployments." className="pb-4" />
      {!r.ok ? (
        <ErrorState problem={r.problem} />
      ) : r.data.items.length === 0 ? (
        <EmptyState icon={<ScrollText />} title="No activity yet" description="Changes made through the platform appear here." />
      ) : (
        <>
          <Table>
            <thead><tr><Th>Time ({tz})</Th><Th>Action</Th><Th>By</Th><Th>Target</Th><Th>Outcome</Th></tr></thead>
            <tbody>
              {r.data.items.map((e) => (
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
                  <Td className="text-[13px]">{e.actorDisplay}</Td>
                  <Td className="text-[13px] text-slate-600">{e.targetDisplay ?? e.targetType ?? '—'}</Td>
                  <Td><Badge tone={e.outcome === 'success' ? 'emerald' : e.outcome === 'denied' ? 'red' : 'amber'}>{e.outcome}</Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} hrefFor={(p) => `/clients/${id}/activity?page=${p}`} label="events" />
        </>
      )}
    </Card>
  );
}
