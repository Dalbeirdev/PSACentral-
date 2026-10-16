import type { AuditEventDto, Paged, PsaConnectionTestDto, PsaInstanceDetail, PsaProviderDescriptor, PsaTestCode } from '@psacc/contracts';
import { CAPABILITY_LABELS, PSA_TEST_CODE_LABELS, type PsaCapabilities } from '@psacc/contracts';
import { Check, ExternalLink, KeyRound, Minus, Pencil, PlugZap } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ConnectionBadge, CredentialBadge, InstanceStatusBadge } from '@/components/psa/badges';
import { Alert } from '@/components/ui/alert';
import { HealthPill, LifecycleStage, SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, relativeTime } from '@/lib/format';
import { DeploymentBinding } from './deployment-binding';

export const metadata: Metadata = { title: 'PSA instance' };

function codeLabel(code: string | null): string {
  if (!code) return '—';
  return (PSA_TEST_CODE_LABELS as Record<string, string>)[code as PsaTestCode] ?? code;
}

/** Rows describing what the bound appliance last reported about the connection (Module 11). */
function applianceRows(i: PsaInstanceDetail, tz: string): [string, ReactNode][] {
  const a = i.appliance;
  if (!a) return [['Appliance', <span key="n" className="font-normal text-slate-500">No appliance has reported yet</span>]];
  const rows: [string, ReactNode][] = [
    ['Reported by', <Link key="d" href={`/deployments/${a.deployment.id}`} className="font-mono text-[12.5px] text-blue-700 hover:underline">{a.deployment.code}</Link>],
  ];
  if (a.lastTestAt) {
    const parts = [formatDateTime(a.lastTestAt, tz), codeLabel(a.lastTestCode)];
    if (a.lastTestHttpStatus) parts.push(`HTTP ${a.lastTestHttpStatus}`);
    if (a.lastTestLatencyMs != null) parts.push(`${a.lastTestLatencyMs} ms`);
    if (a.lastTestedBy) parts.push(a.lastTestedBy === 'worker' ? 'periodic' : a.lastTestedBy === 'remote' ? 'remote command' : 'local admin');
    rows.push(['Last test', parts.join(' · ')]);
  } else {
    rows.push(['Last test', a.status === 'not_configured' ? 'No credentials on the appliance yet' : 'Credentials present, not tested yet']);
  }
  if (a.consecutiveFailures) rows.push(['Consecutive failures', String(a.consecutiveFailures)]);
  for (const [k, v] of Object.entries(a.remoteIdentity)) rows.push([`Remote ${k}`, <span key={k} className="font-mono text-[12.5px]">{v}</span>]);
  if (a.sync?.lastStatus) {
    rows.push(['Last synchronization run', `${formatDateTime(a.sync.lastRunAt, tz)} · ${a.sync.lastStatus} · ${a.sync.itemsReceived} received · ${a.sync.itemsSent} sent${a.sync.itemsFailed ? ` · ${a.sync.itemsFailed} failed` : ''}${a.sync.errorCode ? ` · ${a.sync.errorCode}` : ''}`]);
  } else if (a.sync && !a.sync.implemented) {
    rows.push(['Synchronization', 'The appliance predates the synchronization engine; update its image.']);
  }
  if (a.tickets) rows.push(['Tickets on the appliance', `${a.tickets.open} open of ${a.tickets.total}${a.tickets.pendingOutbound ? ` · ${a.tickets.pendingOutbound} change(s) waiting to push` : ''}${a.tickets.conflictsLast24h ? ` · ${a.tickets.conflictsLast24h} conflict(s) in 24 h` : ''}`]);
  return rows;
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2.5 text-sm">
          <dt className="text-slate-500">{k}</dt>
          <dd className="text-right font-medium text-slate-800">{v ?? <span className="font-normal text-slate-500">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function PsaInstancePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'psa.read')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { saved } = await searchParams;
  const [res, providers, activity, tests] = await Promise.all([
    apiGet<PsaInstanceDetail>(`/psa-instances/${id}`),
    apiGet<PsaProviderDescriptor[]>('/psa-providers'),
    apiGet<Paged<AuditEventDto>>(`/psa-instances/${id}/activity?pageSize=8`),
    apiGet<PsaConnectionTestDto[]>(`/psa-instances/${id}/connection-tests?limit=10`),
  ]);
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) return <Card><ErrorState problem={res.problem} /></Card>;
  const i = res.data;
  const d = providers.ok ? providers.data.find((p) => p.key === i.providerKey) : undefined;
  const method = d?.authMethods.find((m) => m.key === i.authMethod);
  const tz = me.user.timezone;
  const canWrite = can(me, 'psa.write');
  const canBind = can(me, 'deployments.write');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'PSA Management', href: '/psa' }, { label: i.client.displayName, href: `/clients/${i.client.id}/psa` }, { label: i.code }]}
        title={<span className="flex flex-wrap items-center gap-3">{i.displayName}<span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200">{i.code}</span>{i.isSynthetic ? <SyntheticBadge /> : null}</span>}
        description={<>{i.providerName} · <Link href={`/clients/${i.client.id}`} className="text-blue-700 hover:underline">{i.client.displayName}</Link> ({i.client.code})</>}
        eyebrow={<span className="flex flex-wrap gap-2"><InstanceStatusBadge status={i.status} /><ConnectionBadge status={i.connectionStatus} /><CredentialBadge status={i.credentialStatus} /></span>}
        actions={canWrite ? <ButtonLink href={`/psa/${id}/configure`} variant="secondary"><Pencil /> Configure</ButtonLink> : null}
      />
      {saved ? <Alert variant="success" className="mb-4">{saved === 'created' ? 'PSA instance created. Its connection is untested until credentials are set on the appliance and a test succeeds.' : 'Configuration saved and recorded in the activity history.'}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Configuration" description="Non-secret settings, validated by the provider adapter." />
          <CardBody className="pt-2">
            <Rows rows={[
              ['Provider', d ? <span key="p">{d.name}{d.vendor !== d.name && <span className="text-slate-500"> ({d.vendor})</span>}</span> : i.providerName],
              ['Authentication', method?.label ?? i.authMethod],
              ['API endpoint', <span key="e" className="break-all font-mono text-[12.5px]">{i.apiEndpoint}</span>],
              ...((d?.configFields ?? [])
                .filter((f) => i.config[f.key] !== undefined)
                .map((f): [string, ReactNode] => [f.label, <span key={f.key} className="font-mono text-[12.5px]">{f.options?.find((o) => o.value === i.config[f.key])?.label ?? String(i.config[f.key])}</span>])),
              ['Created', `${formatDateTime(i.createdAt, tz)}${i.createdBy ? ` by ${i.createdBy}` : ''}`],
              ['Last updated', formatDateTime(i.updatedAt, tz)],
            ]} />
            {i.notes ? <p className="mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200">{i.notes}</p> : null}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card data-testid="connection-card">
            <CardHeader title="Connection" icon={<PlugZap />} />
            <CardBody className="space-y-3 pt-3">
              <Rows rows={[
                ['Status', <ConnectionBadge key="c" status={i.connectionStatus} />],
                ['Last successful test', i.lastSuccessfulTestAt ? formatDateTime(i.lastSuccessfulTestAt, tz) : 'Never'],
                ...applianceRows(i, tz),
                ['Last successful synchronization', i.lastSyncAt ? formatDateTime(i.lastSyncAt, tz) : 'Never'],
              ]} />
              <p data-testid="connection-explainer" className="text-[12.5px] leading-5 text-slate-500">
                The connection is tested and used only from inside the client’s Docker environment; the Control Plane never calls the PSA API. The status reflects the last real test the appliance reported (from its local admin page or its worker every 15 minutes); synchronization runs and ticket counts come from the same appliance reports.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Credentials" icon={<KeyRound />} />
            <CardBody className="pt-3">
              <div className="mb-3"><CredentialBadge status={i.credentialStatus} /></div>
              {method ? (
                <ul className="space-y-1 text-[13px] text-slate-700">
                  {method.credentialFields.map((c) => <li key={c.key}>{c.label}{c.secret ? <span className="ml-1.5 text-[11px] font-semibold uppercase text-amber-700">secret</span> : null}</li>)}
                </ul>
              ) : null}
              <p className="mt-3 text-[12.5px] leading-5 text-slate-500">Entered on the client’s appliance and stored there. They are never sent to or shown by the control plane.</p>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader title="Enabled services" description="Client services that run through this instance." />
          <CardBody>
            {i.enabledServices.length ? (
              <ul className="flex flex-wrap gap-2">{i.enabledServices.map((s) => <li key={s.id} className="rounded-lg bg-blue-50 px-2.5 py-1 text-[13px] font-medium text-blue-700 ring-1 ring-blue-100">{s.name}</li>)}</ul>
            ) : <p className="text-sm text-slate-500">No services enabled.</p>}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader title="Deployment association" description="Each deployment uses one PSA instance of its client." className="pb-4" />
          {i.deployments.length ? (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {i.deployments.map((dep) => (
                <li key={dep.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
                  <span className="flex flex-wrap items-center gap-3">
                    <Link href={`/deployments/${dep.id}`} className="font-mono text-[13px] font-semibold text-blue-700 hover:underline">{dep.code}</Link>
                    {dep.isSynthetic ? <SyntheticBadge /> : null}
                    <LifecycleStage state={dep.lifecycleState as never} />
                    <HealthPill state={dep.healthState as never} />
                  </span>
                  {dep.boundHere ? (
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-700"><Check className="size-4" aria-hidden="true" /> Uses this instance</span>
                  ) : canBind ? (
                    <DeploymentBinding instanceId={i.id} deploymentId={dep.id} deploymentCode={dep.code} disabled={i.status !== 'active'} />
                  ) : (
                    <span className="text-[13px] text-slate-500">Uses another instance</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500 sm:px-6">This client has no deployments yet.</p>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Adapter capabilities" description={`What the ${i.providerName} API supports. Ticket processing and synchronization run in the client's Docker environment (Module 12); the control plane only validates configuration.`} />
          <CardBody>
            <ul className="grid gap-2 sm:grid-cols-3">
              {(Object.keys(CAPABILITY_LABELS) as (keyof PsaCapabilities)[]).map((k) => (
                <li key={k} className="flex items-center gap-2 text-[13px] text-slate-700">
                  {d?.capabilities[k] ? <Check className="size-4 text-emerald-600" aria-label="Supported by the vendor API" /> : <Minus className="size-4 text-slate-400" aria-label="Not supported" />}
                  {CAPABILITY_LABELS[k]}
                </li>
              ))}
            </ul>
            {d?.docsUrl ? <a href={d.docsUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-blue-700 hover:underline">Vendor API documentation <ExternalLink className="size-3.5" aria-hidden="true" /></a> : null}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader title="Connection tests" description="Every test run on the appliance, as reported by its agent (newest first). Codes and HTTP statuses only; no response bodies, no credentials." className="pb-4" />
          {tests.ok && tests.data.length ? (
            <div className="overflow-x-auto border-t border-slate-100">
              <table className="w-full text-[13px]" aria-label="Connection tests">
                <thead>
                  <tr className="text-left text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                    <th className="px-5 py-2 sm:px-6">When</th><th className="py-2 pr-3">Result</th><th className="py-2 pr-3">HTTP</th><th className="py-2 pr-3">Latency</th><th className="py-2 pr-3">Run by</th><th className="py-2 pr-3">Appliance</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.data.map((t) => (
                    <tr key={`${t.testedAt}-${t.deployment.id}`} className="border-t border-slate-100">
                      <td className="whitespace-nowrap px-5 py-2 sm:px-6">{formatDateTime(t.testedAt, tz)}</td>
                      <td className={`py-2 pr-3 font-medium ${t.ok ? 'text-emerald-700' : 'text-red-700'}`}>{codeLabel(t.code)}<span className="ml-1.5 font-mono text-[11.5px] font-normal text-slate-500">{t.code}</span></td>
                      <td className="py-2 pr-3 tabular-nums">{t.httpStatus ?? '—'}</td>
                      <td className="py-2 pr-3 tabular-nums">{t.latencyMs != null ? `${t.latencyMs} ms` : '—'}</td>
                      <td className="py-2 pr-3">{t.testedBy === 'worker' ? 'periodic (worker)' : t.testedBy === 'local_admin' ? 'local admin' : t.testedBy === 'remote' ? 'remote command' : '—'}</td>
                      <td className="py-2 pr-3"><Link href={`/deployments/${t.deployment.id}`} className="font-mono text-[12.5px] text-blue-700 hover:underline">{t.deployment.code}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500 sm:px-6">No connection test has been reported yet. Tests run on the client’s appliance: open its local admin page, enter the credentials and press “Test connection now”.</p>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          <CardBody>
            {activity.ok && activity.data.items.length ? (
              <ul className="space-y-2.5">
                {activity.data.items.map((e) => (
                  <li key={e.id} className="text-[13px]">
                    <span className="font-mono text-[12px] text-slate-900">{e.action}</span>
                    <span className="block text-slate-500" title={formatDateTime(e.occurredAt, tz)}>{e.actorDisplay} · {relativeTime(e.occurredAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No activity recorded yet.</p>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
