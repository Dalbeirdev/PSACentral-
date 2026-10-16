import type { AuditEventDto, Paged, PsaProviderDescriptor, ServiceDetail } from '@psacc/contracts';
import { integrationDependency } from '@psacc/contracts';
import { Check, Minus, Pencil, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DefaultBadge, DependencyChip, IncompleteBadge, ServiceStatusBadge, UsesPsaBadge } from '@/components/services/badges';
import { ServiceStatusActions } from '@/components/services/service-status-actions';
import { Alert } from '@/components/ui/alert';
import { SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime, relativeTime } from '@/lib/format';
import { dependencySupport, requirementSummary } from '@/lib/services';

export const metadata: Metadata = { title: 'Service' };

const SAVED: Record<string, string> = {
  created: 'Service created and recorded in the activity history. It is active and can be assigned to clients.',
  updated: 'Service saved and recorded in the activity history.',
  activated: 'Service activated. It can be assigned to clients again.',
  deactivated: 'Service deactivated. Existing client assignments are kept; new ones are refused.',
};

export default async function ServicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { saved } = await searchParams;
  const [res, providers, activity] = await Promise.all([
    apiGet<ServiceDetail>(`/services/${id}`),
    apiGet<PsaProviderDescriptor[]>('/psa-providers'),
    apiGet<Paged<AuditEventDto>>(`/services/${id}/activity?pageSize=8`),
  ]);
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) return <Card><ErrorState problem={res.problem} /></Card>;
  const s = res.data;
  const providerList = providers.ok ? providers.data : [];
  const tz = me.user.timezone;
  const canWrite = can(me, 'services.write');
  const psaDeps = s.integrationDependencies.map((k) => integrationDependency(k)).filter((d) => d?.kind === 'psa');

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Service Catalog', href: '/services' }, { label: s.name }]}
        title={<span className="flex flex-wrap items-center gap-3">{s.name}<span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200">{s.key}</span></span>}
        description={s.description || 'No description.'}
        eyebrow={<span className="flex flex-wrap gap-2"><ServiceStatusBadge active={s.isActive} />{s.isDefault ? <DefaultBadge /> : null}{s.requiresPsa ? <UsesPsaBadge /> : null}</span>}
        actions={canWrite ? <ButtonLink href={`/services/${id}/edit`} variant="secondary"><Pencil /> Edit</ButtonLink> : null}
      />
      {saved && SAVED[saved] ? <Alert variant="success" className="mb-4">{SAVED[saved]}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Definition" description="Stored in the organization’s catalog; defaults are only the starting point." />
          <CardBody className="pt-2">
            <DetailRows rows={[
              ['Category', s.category.name],
              ['Default for new clients', s.isDefault ? 'Yes — pre-selected in the onboarding wizard' : 'No'],
              ['Runs through the client’s PSA', s.requiresPsa ? 'Yes — enabled per PSA instance' : 'No'],
              ['Sort order', String(s.sortOrder)],
              ['Created', `${formatDateTime(s.createdAt, tz)}${s.createdBy ? ` by ${s.createdBy}` : ''}`],
              ['Last updated', `${formatDateTime(s.updatedAt, tz)}${s.updatedBy ? ` by ${s.updatedBy}` : ''}`],
            ]} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Status" />
          <CardBody className="space-y-3 pt-3">
            <DetailRows rows={[['Clients assigned', String(s.clientCount)], ['Deployments affected', String(s.deploymentCount)]]} />
            {canWrite ? <ServiceStatusActions service={s} /> : null}
            <p className="text-[12.5px] leading-5 text-slate-500">Deactivating keeps existing assignments and running appliances unchanged; it only stops new assignments. Default services must stay active.</p>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Integration dependencies" description="What the service needs. PSA dependencies are compared with each provider adapter’s declared capabilities." />
          <CardBody>
            {s.integrationDependencies.length ? (
              <>
                <ul className="flex flex-wrap gap-2">{s.integrationDependencies.map((d) => <li key={d}><DependencyChip dep={d} /></li>)}</ul>
                {psaDeps.length ? (
                  <div className="mt-5 overflow-x-auto">
                    <table className="w-full text-[13px]" aria-label="PSA provider support for this service’s dependencies">
                      <thead>
                        <tr className="text-left text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                          <th className="py-1.5 pr-3">Provider</th>
                          {psaDeps.map((d) => <th key={d!.key} className="py-1.5 pr-3">{d!.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {providerList.map((p) => (
                          <tr key={p.key} className="border-t border-slate-100">
                            <td className="py-1.5 pr-3 font-medium text-slate-800">{p.name}</td>
                            {psaDeps.map((d) => {
                              const sup = dependencySupport(d!, p);
                              return (
                                <td key={d!.key} className="py-1.5 pr-3">
                                  {sup === 'supported' ? <span className="inline-flex items-center gap-1 text-emerald-700"><Check className="size-4" aria-hidden="true" /> Supported</span>
                                    : sup === 'unsupported' ? <span className="inline-flex items-center gap-1 text-red-700"><Minus className="size-4" aria-hidden="true" /> Not supported</span>
                                    : <span className="text-slate-500">Decided per provider (Module 12)</span>}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-[12.5px] text-slate-500">From the adapter descriptors (vendor API capabilities). No PSA is called from the Control Plane.</p>
                  </div>
                ) : null}
              </>
            ) : <p className="text-sm text-slate-500">No integration dependencies.</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Configuration requirements" description="Settings a client supplies when assigned. Never credentials." />
          <CardBody>
            {s.configRequirements.length ? (
              <ul className="space-y-2.5">
                {s.configRequirements.map((r) => (
                  <li key={r.key} className="text-[13px]">
                    <span className="font-medium text-slate-900">{r.label}</span> <span className="font-mono text-[11.5px] text-slate-500">{r.key}</span>
                    <span className="block text-slate-500">{requirementSummary(r)}</span>
                    {r.description ? <span className="block text-slate-500">{r.description}</span> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-slate-500">No settings required.</p>}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader title="Assigned clients" icon={<Users />} description="Assignment is managed on each client’s Services page and is included in its deployments’ configuration." className="pb-4" />
          {s.clients.length ? (
            <ul className="divide-y divide-slate-100 border-t border-slate-100" aria-label="Assigned clients">
              {s.clients.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
                  <span className="flex flex-wrap items-center gap-3">
                    <Link href={`/clients/${c.id}/services`} className="font-semibold text-blue-700 hover:underline">{c.displayName}</Link>
                    <span className="font-mono text-[12.5px] text-slate-500">{c.code}</span>
                    {c.isSynthetic ? <SyntheticBadge /> : null}
                  </span>
                  <span className="flex items-center gap-2 text-[13px] text-slate-500">
                    <span className="capitalize">{c.status}</span>
                    {!c.configComplete ? <IncompleteBadge compact /> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500 sm:px-6">No client is assigned this service.</p>}
        </Card>

        <Card>
          <CardHeader title="Recent activity" />
          <CardBody>
            {activity.ok && activity.data.items.length ? (
              <ul className="space-y-2.5">
                {activity.data.items.map((e) => (
                  <li key={e.id} className="text-[13px]">
                    <span className="font-mono text-[12px] text-slate-900">{e.action}</span>
                    <span className="block text-slate-500" title={formatDateTime(e.occurredAt, tz)}>{e.actorDisplay} · {relativeTime(e.occurredAt)}{e.targetType === 'client' && e.targetDisplay ? ` · ${e.targetDisplay}` : ''}</span>
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
