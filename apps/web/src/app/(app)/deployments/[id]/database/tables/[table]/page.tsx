import type { TableDetailDto } from '@psacc/contracts';
import { Columns3, KeyRound, Link2, ListOrdered, TableProperties } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { Breadcrumbs } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatBytesLong, formatEstimate, parseTableRef, tableRef } from '@/lib/database';
import { formatDateTime, relativeTime } from '@/lib/format';
import { MetadataOnlyNote } from '@/components/database/metadata-note';

export const metadata: Metadata = { title: 'Table schema' };

export default async function TableDetailPage({ params }: { params: Promise<{ id: string; table: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'database.metadata.read')) notFound();
  const { id, table } = await params;
  const ref = parseTableRef(decodeURIComponent(table));
  if (!ref) notFound();
  const r = await apiGet<TableDetailDto>(`/deployments/${id}/database/tables/${encodeURIComponent(ref.schema)}/${encodeURIComponent(ref.name)}`);
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) notFound();
    return <Card><ErrorState problem={r.problem} /></Card>;
  }
  const t = r.data;
  const tz = me.user.timezone;
  const full = tableRef(t.schema, t.name);
  const s = t.stats;
  const yesNo = (b: boolean) => (b ? 'yes' : 'no');

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[{ label: 'Database', href: `/deployments/${id}/database` }, { label: full }]} />
      <Card>
        <CardHeader
          title={<span className="font-mono">{full}</span>}
          icon={<TableProperties />}
          description={`${t.kind === 'partitioned' ? 'Partitioned table' : 'Table'} · schema details observed ${relativeTime(t.observedAt)} (${formatDateTime(t.observedAt, tz, { seconds: true })}) · snapshot ${t.fingerprint.slice(0, 12)}`}
          actions={<span className="flex gap-2"><Badge tone="blue">{t.columns.length} columns</Badge><Badge tone={t.primaryKey ? 'emerald' : 'amber'}>{t.primaryKey ? 'Primary key' : 'No primary key'}</Badge></span>}
        />
        <CardBody className="grid gap-x-8 pt-1 md:grid-cols-2">
          <DetailRows rows={[
            ['Estimated rows', <span key="e" title="pg_class.reltuples — a planner estimate, not an exact count">{formatEstimate(s.estimatedRows)}</span>],
            ['Live / dead rows (statistics)', s.liveRows === null && s.deadRows === null ? null : `${s.liveRows ?? '—'} / ${s.deadRows ?? '—'}`],
            ['Last analyze', s.lastAnalyzeAt ? formatDateTime(s.lastAnalyzeAt, tz, { seconds: true }) : s.lastAutoanalyzeAt ? `auto · ${formatDateTime(s.lastAutoanalyzeAt, tz, { seconds: true })}` : <span key="a" className="font-normal text-slate-500">Never</span>],
            ['Last vacuum', s.lastVacuumAt ? formatDateTime(s.lastVacuumAt, tz, { seconds: true }) : s.lastAutovacuumAt ? `auto · ${formatDateTime(s.lastAutovacuumAt, tz, { seconds: true })}` : <span key="v" className="font-normal text-slate-500">Never</span>],
          ]} />
          <DetailRows rows={[
            ['Total size', formatBytesLong(s.totalBytes)],
            ['Table data', formatBytesLong(s.tableBytes)],
            ['Indexes', formatBytesLong(s.indexBytes)],
            ['TOAST (out-of-line values)', formatBytesLong(s.toastBytes)],
          ]} />
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Columns" icon={<Columns3 />} description="Name, type, nullability and default expression from pg_attribute." className="pb-4" />
        <Table>
          <thead><tr><Th>#</Th><Th>Column</Th><Th>Type</Th><Th>Nullable</Th><Th>Default</Th><Th>Identity</Th></tr></thead>
          <tbody>
            {t.columns.map((c) => (
              <Tr key={c.name}>
                <Td className="tabular-nums text-[12.5px] text-slate-500">{c.position}</Td>
                <Td className="font-mono text-[13px] font-semibold text-slate-900">{c.name}{t.primaryKey?.columns.includes(c.name) ? <KeyRound className="ml-1.5 inline size-3.5 text-amber-600" aria-label="primary key column" /> : null}</Td>
                <Td className="font-mono text-[12.5px] text-slate-700">{c.type}</Td>
                <Td className="text-[13px]">{yesNo(c.nullable)}</Td>
                <Td className="max-w-80 break-all font-mono text-[12px] text-slate-600">{c.default ?? <span className="font-sans text-slate-400">—</span>}</Td>
                <Td className="text-[13px]">{yesNo(c.identity)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Primary key" icon={<KeyRound />} />
          <CardBody className="pt-1">
            {t.primaryKey ? <DetailRows rows={[['Constraint', <span key="n" className="font-mono text-[12.5px]">{t.primaryKey.name}</span>], ['Columns', <span key="c" className="font-mono text-[12.5px]">{t.primaryKey.columns.join(', ')}</span>]]} /> : <p className="text-sm text-slate-500">This table has no primary key.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Foreign keys" icon={<Link2 />} description="References to other tables in this database." />
          <CardBody className="pt-1">
            {t.foreignKeys.length ? (
              <ul className="divide-y divide-slate-100 text-[13px]" aria-label="Foreign keys">
                {t.foreignKeys.map((f) => (
                  <li key={f.name} className="py-2">
                    <span className="font-mono text-[12.5px] text-slate-900">{f.name}</span>
                    <span className="mt-0.5 block font-mono text-[12.5px] text-slate-600">
                      ({f.columns.join(', ')}) → <Link href={`/deployments/${id}/database/tables/${encodeURIComponent(tableRef(f.referencedSchema, f.referencedTable))}`} className="text-blue-700 underline decoration-blue-700/40 underline-offset-2 hover:decoration-blue-700">{tableRef(f.referencedSchema, f.referencedTable)}</Link> ({f.referencedColumns.join(', ')})
                    </span>
                    <span className="block text-[12px] text-slate-500">on delete: {f.onDelete.replace('_', ' ')}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No foreign keys.</p>}
          </CardBody>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="Indexes" icon={<ListOrdered />} description="Definitions from pg_get_indexdef, with each index's size." className="pb-4" />
        {t.indexes.length ? (
          <Table>
            <thead><tr><Th>Index</Th><Th>Unique</Th><Th>Primary</Th><Th>Size</Th><Th>Definition</Th></tr></thead>
            <tbody>
              {t.indexes.map((i) => (
                <Tr key={i.name}>
                  <Td className="font-mono text-[12.5px] font-semibold text-slate-900">{i.name}</Td>
                  <Td className="text-[13px]">{yesNo(i.unique)}</Td>
                  <Td className="text-[13px]">{yesNo(i.primary)}</Td>
                  <Td className="tabular-nums text-[13px]">{formatBytesLong(i.sizeBytes)}</Td>
                  <Td className="max-w-xl whitespace-normal break-all font-mono text-[12px] text-slate-600">{i.definition}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <CardBody className="pt-1"><p className="text-sm text-slate-500">No indexes.</p></CardBody>}
        <CardBody className="border-t border-slate-100 pt-4"><MetadataOnlyNote /></CardBody>
      </Card>
    </div>
  );
}
