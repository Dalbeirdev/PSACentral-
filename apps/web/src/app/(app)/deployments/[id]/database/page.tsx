import type { DeploymentDatabaseDto } from '@psacc/contracts';
import { ChartBar, CircleAlert, Database, TableProperties } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MetadataOnlyNote } from '@/components/database/metadata-note';
import { TableSizeChart } from '@/components/database/table-size-chart';
import { RefreshButton } from '@/components/refresh-button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatBytesLong, formatEstimate, tableRef, tableStatus } from '@/lib/database';
import { formatDateTime, relativeTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Deployment database' };

export default async function DeploymentDatabasePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'database.metadata.read')) notFound();
  const { id } = await params;
  const r = await apiGet<DeploymentDatabaseDto>(`/deployments/${id}/database`);
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) notFound();
    return <Card><ErrorState problem={r.problem} /></Card>;
  }
  const d = r.data;
  const tz = me.user.timezone;
  const db = d.database;

  if (d.isSynthetic) {
    return (
      <Card>
        <CardHeader title="Database" icon={<Database />} description="Synthetic sample record" />
        <EmptyState icon={<Database />} title="No appliance database" description="This deployment is development sample data: no appliance exists, so no inspector has reported a database. Live deployments show their real table inventory here." />
      </Card>
    );
  }
  if (!db) {
    return (
      <div className="space-y-4">
        <Alert variant="info" title="Awaiting the first inventory">
          {['enrolled', 'verified'].includes(d.lifecycleState) ? 'The agent is enrolled; its first database report has not arrived yet.' : 'No agent has enrolled for this deployment, so nothing has been inspected.'} Metadata arrives only through the agent's secure channel.
        </Alert>
        <Card>
          <CardHeader title="Database" icon={<Database />} actions={<RefreshButton />} />
          <EmptyState icon={<Database />} title="No inventory reported" description="This page will show availability, PostgreSQL version, size, schema and migration version, and the table inventory with estimated rows and sizes." />
          <CardBody className="pt-0"><MetadataOnlyNote /></CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Database"
          icon={<Database />}
          description={`Inventory reported ${relativeTime(db.observedAt)} (${formatDateTime(db.observedAt, tz, { seconds: true })}) by the appliance's catalog-only inspector role.`}
          actions={<RefreshButton />}
        />
        <CardBody className="grid gap-x-8 pt-1 md:grid-cols-2">
          <DetailRows rows={[
            ['Database name', db.databaseName ? <span key="n" className="font-mono">{db.databaseName}</span> : null],
            ['Connection', db.available ? <span key="a" className="text-emerald-700">Available</span> : <span key="a" className="text-red-700">Unavailable{db.error ? ` (${db.error})` : ''}</span>],
            ['PostgreSQL', db.serverVersion],
            ['Size', formatBytesLong(db.sizeBytes)],
            ['Tables', db.tableCount],
          ]} />
          <DetailRows rows={[
            ['Schema version', db.schemaVersion ? <span key="s" className="font-mono">{db.schemaVersion}</span> : null],
            ['Migrations applied', `${db.migrationsApplied}${db.lastMigratedAt ? ` · last ${formatDateTime(db.lastMigratedAt, tz)}` : ''}`],
            ['Last successful inventory', db.available && !db.error ? formatDateTime(db.observedAt, tz, { seconds: true }) : <span key="i" className="font-normal text-slate-500">The latest inventory failed</span>],
            ['Schema details', d.inspection.lastSchemaAt ? `${d.inspection.detailedTables} of ${d.tables.length} tables · ${formatDateTime(d.inspection.lastSchemaAt, tz, { seconds: true })}` : <span key="d" className="font-normal text-slate-500">Pending — the agent sends them after the inventory</span>],
            ['Inspection errors (7 days)', d.errors.length ? <span key="e" className="text-red-700">{d.errors.reduce((n, e) => n + e.count, 0)}</span> : 'None'],
          ]} />
        </CardBody>
      </Card>

      {d.errors.length ? (
        <Card>
          <CardHeader title="Inspection errors" icon={<CircleAlert />} description="Error codes the agent reported for its database inspection in the last 7 days (codes only; never content)." />
          <CardBody className="pt-1">
            <ul className="divide-y divide-slate-100 text-[13px]" aria-label="Inspection errors">
              {d.errors.map((e) => <li key={e.code} className="flex flex-wrap justify-between gap-2 py-2"><span className="font-mono text-slate-900">{e.code}</span><span className="text-slate-500">{e.count}× · first {formatDateTime(e.firstSeenAt, tz, { seconds: true })} · last {formatDateTime(e.lastSeenAt, tz, { seconds: true })}</span></li>)}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <CardHeader title="Tables" icon={<TableProperties />} description="Every table in the public schema of the appliance database. Open a table for its columns, keys and indexes." className="pb-4" />
        {d.tables.length === 0 ? (
          <EmptyState icon={<TableProperties />} title="No tables in the inventory" />
        ) : (
          <Table aria-label="Table inventory">
            <thead>
              <tr><Th>Table</Th><Th>Schema</Th><Th><abbr title="Estimate from pg_class.reltuples; not an exact count">Est. rows ≈</abbr></Th><Th>Size</Th><Th>Columns</Th><Th>Keys &amp; indexes</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {d.tables.map((t) => {
                const s = tableStatus(t);
                return (
                  <Tr key={tableRef(t.schema, t.name)}>
                    <Td>{t.detailsObservedAt ? <Link href={`/deployments/${id}/database/tables/${encodeURIComponent(tableRef(t.schema, t.name))}`} className="font-mono text-[13px] font-semibold text-blue-700 hover:underline">{t.name}</Link> : <span className="font-mono text-[13px] font-semibold text-slate-700">{t.name}</span>}</Td>
                    <Td className="font-mono text-[12.5px] text-slate-600">{t.schema}</Td>
                    <Td className="tabular-nums text-[13px]">{formatEstimate(t.estimatedRows)}</Td>
                    <Td className="tabular-nums text-[13px]">{formatBytesLong(t.sizeBytes)}</Td>
                    <Td className="tabular-nums text-[13px]">{t.columns}</Td>
                    <Td className="text-[12.5px] text-slate-600">{t.hasPrimaryKey ? 'PK' : 'no PK'} · {t.indexes} {t.indexes === 1 ? 'index' : 'indexes'} · {t.foreignKeys} FK</Td>
                    <Td><Badge tone={s.tone}>{s.label}</Badge></Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <CardBody className="space-y-2 border-t border-slate-100 pt-4">
          <p className="text-[12.5px] text-slate-500">≈ Estimated rows come from <code className="font-mono">pg_class.reltuples</code> (PostgreSQL's planner statistics); they are not an exact count. "Never analysed" means PostgreSQL has not gathered statistics for the table yet.</p>
          <MetadataOnlyNote />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Largest tables" icon={<ChartBar />} description="Total on-disk size (table, indexes and TOAST) from the latest inventory. The full list is in the table above." />
        <CardBody className="pt-1"><TableSizeChart tables={d.tables.map((t) => ({ name: t.name, sizeBytes: t.sizeBytes }))} /></CardBody>
      </Card>
    </div>
  );
}
