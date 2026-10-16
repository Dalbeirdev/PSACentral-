import type { AuditEventDto, LicenseDetail, Paged } from '@psacc/contracts';
import { LIFECYCLE_LABELS } from '@psacc/contracts';
import { KeyRound, Pencil, Server } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LicenseActions, LicenseStatusBadge, TermBadge } from '@/components/licenses/license-bits';
import { Alert } from '@/components/ui/alert';
import { Badge, HealthPill, SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { DetailRows } from '@/components/ui/detail-rows';
import { PageHeader } from '@/components/ui/page-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatCalendarDate, formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'License' };

export default async function LicensePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const saved = (await searchParams).saved;
  const r = await apiGet<LicenseDetail>(`/licenses/${id}`);
  if (!r.ok) {
    if (r.status === 404) notFound();
    throw new Error(r.problem.detail ?? 'The license could not be loaded.');
  }
  const l = r.data;
  const tz = me.user.timezone;
  const canManage = can(me, 'licenses.manage') && !l.isSynthetic;
  const activity = await apiGet<Paged<AuditEventDto>>(`/audit-events?targetType=license&targetId=${id}&pageSize=20`);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Licenses', href: '/licenses' }, { label: l.code }]}
        eyebrow={<span className="inline-flex flex-wrap items-center gap-2"><LicenseStatusBadge status={l.status} /><TermBadge l={l} />{l.isSynthetic ? <SyntheticBadge /> : null}</span>}
        title={<span className="font-mono">{l.code}</span>}
        description={<>{l.displayName} · <Link href={`/clients/${l.client.id}`} className="text-blue-700 hover:underline">{l.client.displayName}</Link> ({l.client.code})</>}
        actions={canManage && l.status !== 'revoked' ? <ButtonLink href={`/licenses/${id}/edit`} variant="secondary" data-testid="edit-license"><Pencil /> Edit</ButtonLink> : undefined}
      />
      {saved === 'created' ? <Alert variant="success" title={`License ${l.code} created.`} className="mb-4">Bind deployments to it when creating them (the client's active license is chosen by default) or in a draft deployment's settings.</Alert> : null}
      {saved === 'updated' ? <Alert variant="success" title="License updated and recorded in the activity history." className="mb-4" /> : null}
      {l.isSynthetic ? <Alert variant="synthetic" title="Synthetic sample record" className="mb-4">Development sample data; it cannot be changed.</Alert> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Entitlement" icon={<KeyRound />} />
          <CardBody className="pt-1">
            <DetailRows rows={[
              ['License ID', <span key="i" className="font-mono text-[12.5px]">{l.id}</span>],
              ['Plan', l.displayName],
              ['Term', <span key="t" className="inline-flex flex-wrap items-center gap-2">{formatCalendarDate(l.startsAt)} → {l.endsAt ? formatCalendarDate(l.endsAt) : 'no end date'} <TermBadge l={l} /></span>],
              ['Deployments', <span key="d">{l.deploymentsUsed} of {l.maxDeployments} in use {l.deploymentsUsed >= l.maxDeployments ? <Badge tone="amber" className="ml-1">full</Badge> : null}</span>],
              ['Status', <span key="s" className="inline-flex flex-wrap items-center gap-2"><LicenseStatusBadge status={l.status} />{l.suspendedAt ? <span className="text-[12.5px] text-slate-600">since {formatDateTime(l.suspendedAt, tz)} — {l.suspendedReason}</span> : null}{l.revokedAt ? <span className="text-[12.5px] text-slate-600">revoked {formatDateTime(l.revokedAt, tz)} — {l.revokeReason}</span> : null}</span>],
              ['Created', `${formatDateTime(l.createdAt, tz)}${l.createdBy ? ` by ${l.createdBy}` : ''}`],
              ['Last updated', `${formatDateTime(l.updatedAt, tz)}${l.updatedBy ? ` by ${l.updatedBy}` : ''}`],
            ]} />
            {l.notes ? <div className="mt-4 rounded-lg bg-amber-50/60 p-3 ring-1 ring-amber-200/70"><p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-amber-800">Notes</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{l.notes}</p></div> : null}
            {canManage ? <div className="mt-5 border-t border-slate-100 pt-4"><LicenseActions license={l} /></div> : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="What this license controls" />
          <CardBody className="pt-1">
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-slate-700">
              <li>Deployments bound to it can generate packages and enroll only while it is active, within its term and under its deployment limit.</li>
              <li>Appliances already running keep working when the license expires or is suspended; their health shows a licensing finding, and you suspend or decommission them deliberately.</li>
              <li>The identifier travels with the package and is shown on the appliance; the appliance enforces nothing itself.</li>
            </ul>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="Deployments under this license" icon={<Server />} description={`${l.deploymentsUsed} of ${l.maxDeployments} slot(s) in use; decommissioned deployments do not count.`} />
        <CardBody className="pt-1">
          {l.deployments.length ? (
            <Table data-testid="license-deployments">
              <thead><tr><Th>Deployment</Th><Th>Lifecycle</Th><Th>Health</Th><Th>Host</Th></tr></thead>
              <tbody>
                {l.deployments.map((d) => (
                  <Tr key={d.id}>
                    <Td><Link href={`/deployments/${d.id}`} className="font-mono text-[12.5px] font-semibold text-blue-700 hover:underline">{d.code}</Link></Td>
                    <Td>{LIFECYCLE_LABELS[d.lifecycleState]}{d.suspendedAt ? <span className="block text-[12px] text-slate-500">since {formatDateTime(d.suspendedAt, tz)}</span> : null}</Td>
                    <Td><HealthPill state={d.healthState} /></Td>
                    <Td className="text-slate-700">{d.hostLabel ?? '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : <p className="text-sm text-slate-500">No deployment is bound to this license yet.</p>}
        </CardBody>
      </Card>
      <Card className="mt-4">
        <CardHeader title="Activity" description="Audit events for this license." />
        <CardBody className="pt-1">
          {activity.ok && activity.data.items.length ? (
            <ul className="divide-y divide-slate-100 text-[13px]" data-testid="license-activity">
              {activity.data.items.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="font-mono text-[12px] text-slate-500">{formatDateTime(e.occurredAt, tz, { seconds: true })}</span>
                  <span className="font-medium text-slate-800">{e.action}</span>
                  <span className="text-slate-600">{e.actorDisplay}</span>
                  {e.metadata && 'reason' in e.metadata ? <span className="text-slate-600">— {String(e.metadata.reason)}</span> : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-500">No activity recorded yet.</p>}
        </CardBody>
      </Card>
    </>
  );
}
