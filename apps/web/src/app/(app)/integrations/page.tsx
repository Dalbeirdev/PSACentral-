import type { IntegrationRow, PsaProviderDescriptor, PsaTestCode } from '@psacc/contracts';
import { PSA_TEST_CODE_LABELS } from '@psacc/contracts';
import { Funnel, Plug } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ConnectionBadge, CredentialBadge } from '@/components/psa/badges';
import { Alert } from '@/components/ui/alert';
import { Badge, SyntheticBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { notFound } from 'next/navigation';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, relativeTime } from '@/lib/format';
import { hrefWith, pickParams } from '@/lib/query';

export const metadata: Metadata = { title: 'Integrations' };

const KEYS = ['q', 'provider', 'connectionStatus', 'credentialStatus', 'live'] as const;
const selectClass = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 pr-8 text-sm';

function codeLabel(code: string | null): string {
  if (!code) return '—';
  return (PSA_TEST_CODE_LABELS as Record<string, string>)[code as PsaTestCode] ?? code;
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'integrations.read')) notFound();
  const params = pickParams(await searchParams, KEYS);
  const [result, providers] = await Promise.all([
    apiGet<IntegrationRow[]>(hrefWith('/integrations', params, {})),
    apiGet<PsaProviderDescriptor[]>('/psa-providers'),
  ]);
  const href = (c: Record<string, string | number | undefined>) => hrefWith('/integrations', params, c);
  const filtered = KEYS.some((k) => params[k]);
  const providerList = providers.ok ? providers.data : [];
  const tz = me.user.timezone;
  const rows = result.ok ? result.data : [];
  const summary = {
    succeeded: rows.filter((r) => r.connectionStatus === 'succeeded').length,
    failed: rows.filter((r) => r.connectionStatus === 'failed').length,
    untested: rows.filter((r) => r.connectionStatus === 'untested').length,
    reporting: rows.filter((r) => r.appliance).length,
  };

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
        title="Integrations"
        description="Every PSA connection and what the client’s appliance reports about it. Credentials are entered and tested on the appliance; the Control Plane only receives the outcome and never calls a PSA API."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="integration-summary">
        {[
          { key: 'succeeded', label: 'Verified', value: summary.succeeded, tone: 'text-emerald-700' },
          { key: 'failed', label: 'Failing', value: summary.failed, tone: 'text-red-700' },
          { key: 'untested', label: 'Untested', value: summary.untested, tone: 'text-slate-700' },
          { key: 'reporting', label: 'Appliances reporting', value: summary.reporting, tone: 'text-blue-700' },
        ].map((k) => (
          <div key={k.key} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-[12px] font-medium uppercase tracking-[0.08em] text-slate-500">{k.label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${k.tone}`} data-testid={`integration-count-${k.key}`}>{k.value}</p>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden">
        <form className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4 sm:px-6" role="search" aria-label="Filter integrations">
          <div className="min-w-56 flex-[2]">
            <label htmlFor="q" className="mb-1.5 block text-xs font-medium text-slate-500">Search</label>
            <input id="q" name="q" defaultValue={params.q} placeholder="Instance, code or client" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/10" />
          </div>
          {filter('provider', 'Provider', providerList.map((p) => ({ value: p.key, label: p.name })))}
          {filter('connectionStatus', 'Connection', [{ value: 'succeeded', label: 'Verified' }, { value: 'failed', label: 'Failing' }, { value: 'untested', label: 'Untested' }])}
          {filter('credentialStatus', 'Credentials', [{ value: 'pending_appliance', label: 'Pending on appliance' }, { value: 'not_configured', label: 'Not configured' }, { value: 'configured', label: 'Configured' }, { value: 'invalid', label: 'Invalid' }, { value: 'expired', label: 'Expired' }])}
          {filter('live', 'Records', [{ value: '1', label: 'Live only (no synthetic)' }])}
          <Button type="submit" variant="secondary"><Funnel /> Apply</Button>
          {filtered ? <Link href="/integrations" className="h-9 px-2 text-sm font-medium leading-9 text-slate-500 hover:text-slate-900">Clear</Link> : null}
        </form>
        {!result.ok ? (
          <ErrorState problem={result.problem} />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Plug />} title={filtered ? 'No integrations match these filters' : 'No PSA instances yet'} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>PSA instance</Th>
                <Th>Client</Th>
                <Th>Connection</Th>
                <Th>Credentials</Th>
                <Th>Last test (on the appliance)</Th>
                <Th>Synchronization</Th>
                <Th>Tickets</Th>
                <Th>Appliance</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <Tr key={i.id} data-testid={`integration-${i.code}`}>
                  <Td>
                    <Link href={`/psa/${i.id}`} className="group block min-w-48">
                      <span className="block font-semibold text-slate-900 group-hover:text-blue-700">{i.displayName}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[12.5px] text-slate-500"><span className="font-mono">{i.code}</span> · {i.providerName}{i.isSynthetic ? <SyntheticBadge /> : null}</span>
                    </Link>
                  </Td>
                  <Td className="text-[13px]"><Link href={`/clients/${i.client.id}`} className="hover:text-blue-700">{i.client.displayName}</Link></Td>
                  <Td><ConnectionBadge status={i.connectionStatus} /></Td>
                  <Td><CredentialBadge status={i.credentialStatus} /></Td>
                  <Td className="text-[13px] text-slate-700">
                    {i.appliance?.lastTestAt ? (
                      <>
                        <span className={i.appliance.lastTestCode === 'ok' ? 'font-medium text-emerald-700' : 'font-medium text-red-700'}>{codeLabel(i.appliance.lastTestCode)}</span>
                        <span className="block text-[12.5px] text-slate-500" title={formatDateTime(i.appliance.lastTestAt, tz)}>
                          {relativeTime(i.appliance.lastTestAt)}{i.appliance.lastTestHttpStatus ? ` · HTTP ${i.appliance.lastTestHttpStatus}` : ''}{i.appliance.lastTestLatencyMs != null ? ` · ${i.appliance.lastTestLatencyMs} ms` : ''}{i.appliance.lastTestedBy ? ` · ${i.appliance.lastTestedBy === 'worker' ? 'periodic' : i.appliance.lastTestedBy === 'remote' ? 'remote command' : 'local admin'}` : ''}
                        </span>
                      </>
                    ) : i.appliance ? (
                      <span className="text-slate-500">{i.appliance.status === 'not_configured' ? 'No credentials on the appliance yet' : 'Credentials present, not tested yet'}</span>
                    ) : (
                      <span className="text-slate-500">No appliance has reported</span>
                    )}
                  </Td>
                  <Td className="text-[13px] text-slate-700" data-testid="sync-cell">
                    {i.appliance?.sync?.lastStatus ? (
                      <>
                        <span className={i.appliance.sync.lastStatus === 'succeeded' ? 'font-medium text-emerald-700' : i.appliance.sync.lastStatus === 'failed' ? 'font-medium text-red-700' : 'font-medium text-amber-700'}>{i.appliance.sync.lastStatus}</span>
                        <span className="block text-[12.5px] text-slate-500" title={i.appliance.sync.lastRunAt ? formatDateTime(i.appliance.sync.lastRunAt, tz) : undefined}>
                          {i.appliance.sync.lastRunAt ? relativeTime(i.appliance.sync.lastRunAt) : ''}{` · ${i.appliance.sync.itemsReceived} in · ${i.appliance.sync.itemsSent} out`}{i.appliance.sync.itemsFailed ? ` · ${i.appliance.sync.itemsFailed} failed` : ''}{i.appliance.sync.errorCode ? ` · ${i.appliance.sync.errorCode}` : ''}
                        </span>
                      </>
                    ) : i.appliance?.sync && !i.appliance.sync.implemented ? (
                      <span className="text-slate-500">Agent predates synchronization</span>
                    ) : (
                      <span className="text-slate-500">No run yet</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-[13px] text-slate-700 tabular-nums" data-testid="tickets-cell">
                    {i.appliance?.tickets ? <>{i.appliance.tickets.open} open / {i.appliance.tickets.total}{i.appliance.tickets.pendingOutbound ? <span className="block text-[12.5px] text-amber-700">{i.appliance.tickets.pendingOutbound} waiting to push</span> : null}</> : <span className="text-slate-500">—</span>}
                  </Td>
                  <Td className="text-[13px]">
                    {i.appliance ? (
                      <Link href={`/deployments/${i.appliance.deployment.id}`} className="font-mono text-[12.5px] text-blue-700 hover:underline">{i.appliance.deployment.code}</Link>
                    ) : (
                      <span className="text-slate-500">{i.deploymentCount} deployment{i.deploymentCount === 1 ? '' : 's'}</span>
                    )}
                    {i.appliance && !i.appliance.apiCallsImplemented ? <Badge tone="amber" className="ml-2 h-5 px-1.5 text-[11px]">Agent predates tests</Badge> : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Alert variant="info" className="mt-4">
        Statuses come from each appliance’s own test (run from the local admin page or every 15 minutes by its worker) and reach this page with the agent’s next report. A “Verified” connection always carries the time of a real success; the database refuses anything else. Synchronization and ticket figures are counts reported by the appliance, whose database is the system of record; no ticket content reaches the Control Plane.
      </Alert>
    </>
  );
}
