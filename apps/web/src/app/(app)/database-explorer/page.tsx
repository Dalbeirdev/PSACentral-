import type { DatabaseExplorerDto } from '@psacc/contracts';
import { Database, Funnel } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RefreshButton } from '@/components/refresh-button';
import { Alert } from '@/components/ui/alert';
import { Badge, HealthPill, SyntheticBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatBytesLong } from '@/lib/database';
import { formatDateTime, relativeTime } from '@/lib/format';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'Database Explorer' };
const KEYS = ['q', 'live', 'availability'] as const;

const TILES: { key: 'available' | 'unavailable' | 'awaiting'; label: string; tone: 'emerald' | 'red' | 'neutral' }[] = [
  { key: 'available', label: 'Database available', tone: 'emerald' },
  { key: 'unavailable', label: 'Database unavailable', tone: 'red' },
  { key: 'awaiting', label: 'Awaiting first inventory', tone: 'neutral' },
];

export default async function DatabaseExplorerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'database.metadata.read')) notFound();
  const params = pickParams(await searchParams, KEYS);
  const r = await apiGet<DatabaseExplorerDto>(hrefWith('/database-explorer', params, {}));
  if (!r.ok) return <Card><ErrorState problem={r.problem} /></Card>;
  const f = r.data;
  const tz = me.user.timezone;
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/database-explorer', params, c);

  return (
    <>
      <PageHeader
        title="Database Explorer"
        description="Each appliance database as described by its agent's catalog-only inspector role: availability, version, size, schema version and the table inventory. Table rows are never transferred, and there is no SQL console."
        actions={<RefreshButton />}
      />
      {f.summary.synthetic > 0 && !params.live ? (
        <Alert variant="synthetic" title={`${f.summary.synthetic} of ${f.summary.live + f.summary.synthetic} deployments are synthetic sample records`} className="mb-4" actions={<Link href={href({ live: '1' })} className="text-sm font-semibold underline">Show live only</Link>}>
          Synthetic records have no appliance and therefore no database metadata. The counts below cover live deployments only.
        </Alert>
      ) : null}

      <nav aria-label="Database availability" className="mb-4 grid gap-3 sm:grid-cols-3">
        {TILES.map((t) => (
          <Link key={t.key} href={href({ availability: params.availability === t.key ? undefined : t.key })} aria-current={params.availability === t.key ? 'true' : undefined}
            className={`rounded-xl border bg-white px-4 py-3 transition-shadow hover:shadow-card ${params.availability === t.key ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}>
            <p className="text-2xl font-semibold tabular-nums text-slate-900" data-testid={`db-${t.key}`}>{f.summary[t.key]}</p>
            <p className="text-[12.5px] font-medium text-slate-500"><Badge tone={t.tone}>{t.label}</Badge></p>
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
          {params.availability ? <input type="hidden" name="availability" value={params.availability} /> : null}
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {params.q || params.live || params.availability ? <Link href="/database-explorer" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>
        {f.rows.length === 0 ? (
          <EmptyState icon={<Database />} title="No deployments match" />
        ) : (
          <Table>
            <thead>
              <tr><Th>Deployment</Th><Th>Database</Th><Th>PostgreSQL</Th><Th>Schema</Th><Th>Tables</Th><Th>Size</Th><Th>Last inventory</Th></tr>
            </thead>
            <tbody>
              {f.rows.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <Link href={`/deployments/${d.id}/database`} className="group block min-w-44">
                      <span className="block font-mono text-[13px] font-semibold text-blue-700 group-hover:underline">{d.code}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500">{d.client.displayName}{d.isSynthetic ? <SyntheticBadge /> : null}</span>
                    </Link>
                  </Td>
                  <Td className="text-[13px]">
                    {d.isSynthetic ? <span className="italic text-slate-500">No appliance</span>
                      : !d.database ? <span className="text-slate-500">Awaiting first inventory</span>
                      : d.database.available ? <span className="inline-flex flex-col"><span className="font-medium text-emerald-700">Available</span>{d.database.databaseName ? <span className="font-mono text-[11.5px] text-slate-500">{d.database.databaseName}</span> : null}</span>
                      : <span className="inline-flex flex-col"><span className="font-medium text-red-700">Unavailable</span>{d.database.error ? <span className="font-mono text-[11.5px] text-slate-500">{d.database.error}</span> : null}</span>}
                    <span className="mt-1 block"><HealthPill state={d.healthState} /></span>
                  </Td>
                  <Td className="text-[13px] text-slate-700">{d.database?.serverVersion ?? '—'}</Td>
                  <Td className="text-[13px] text-slate-700">{d.database?.schemaVersion ? <><span className="font-mono">{d.database.schemaVersion}</span><span className="block text-[11.5px] text-slate-500">{d.database.migrationsApplied} migrations</span></> : '—'}</Td>
                  <Td className="text-[13px] text-slate-700">{d.database ? <><span className="tabular-nums">{d.database.tableCount}</span><span className="block text-[11.5px] text-slate-500">{d.detailedTables} with details</span></> : '—'}</Td>
                  <Td className="text-[13px] tabular-nums text-slate-700">{d.database ? formatBytesLong(d.database.sizeBytes) : '—'}</Td>
                  <Td className="whitespace-nowrap text-[13px] text-slate-600">{d.database ? <span title={formatDateTime(d.database.observedAt, tz, { seconds: true })}>{relativeTime(d.database.observedAt)}</span> : d.isSynthetic ? <span className="italic text-slate-500">Synthetic — not live</span> : 'Never'}</Td>
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
