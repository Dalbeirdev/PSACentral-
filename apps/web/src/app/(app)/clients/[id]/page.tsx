import type { AuditEventDto, LicenseSummary, Paged } from '@psacc/contracts';
import { Contact, KeyRound, Mail, Phone, UserRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { HealthBar } from '@/components/clients/badges';
import { LicenseStatusBadge } from '@/components/licenses/license-bits';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { getClient } from '@/lib/clients';
import { daysUntil, formatCalendarDate, formatDateTime, relativeTime } from '@/lib/format';
import { CONTACT_ROLE_LABEL, countryName } from '@/lib/reference';

export const metadata: Metadata = { title: 'Client' };

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2.5 text-sm">
          <dt className="text-slate-500">{k}</dt>
          <dd className="text-right font-medium text-slate-800">{v || <span className="font-normal text-slate-500">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="rounded-xl border border-slate-200 bg-white px-4 py-3 transition-shadow hover:shadow-card">
      <p className="text-[12.5px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
    </Link>
  );
}

export default async function ClientOverviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const { saved } = await searchParams;
  const c = await getClient(id);
  const licenses = await apiGet<Paged<LicenseSummary>>(`/licenses?clientId=${id}&pageSize=10`);
  const activity = await apiGet<Paged<AuditEventDto>>(`/clients/${id}/activity?pageSize=5`);
  const tz = me.user.timezone;
  const contractDays = c.contractEndDate ? daysUntil(c.contractEndDate) : null;

  return (
    <div className="space-y-4">
      {saved ? <Alert variant="success">Client saved. The change is recorded in the activity history.</Alert> : null}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Contacts" value={c.counts.contacts} href={`/clients/${id}/contacts`} />
        <Stat label="Services" value={c.counts.services} href={`/clients/${id}/services`} />
        <Stat label="PSA instances" value={c.counts.psaInstances} href={`/clients/${id}/psa`} />
        <Stat label="Deployments" value={c.counts.deployments} href={`/clients/${id}/deployments`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Company" />
          <CardBody className="pt-2">
            <Rows rows={[
              ['Client ID', <span key="i" className="font-mono">{c.code}</span>],
              ['Legal name', c.legalName],
              ['Display name', c.displayName],
              ['Client reference', <span key="r" className="font-mono">{c.clientReference}</span>],
              ['Business type', c.businessType],
              ['Location', [c.city, c.stateRegion, countryName(c.countryCode)].filter((x) => x && x !== '—').join(', ')],
              ['Time zone', c.timezone],
              ['Website', c.website ? <a key="w" href={c.website} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">{c.website}</a> : null],
            ]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Primary contact" icon={<Contact />} actions={<Link href={`/clients/${id}/contacts`} className="text-[13px] font-medium text-blue-700 hover:underline">All contacts</Link>} />
          <CardBody>
            {c.primaryContact ? (
              <div className="space-y-2 text-sm">
                <p className="font-semibold text-slate-900">{c.primaryContact.fullName}</p>
                {c.primaryContact.jobTitle ? <p className="text-slate-500">{c.primaryContact.jobTitle}</p> : null}
                <p className="flex items-center gap-2"><Mail className="size-4 text-slate-400" aria-hidden="true" /><a href={`mailto:${c.primaryContact.email}`} className="text-blue-700 hover:underline">{c.primaryContact.email}</a></p>
                {c.primaryContact.phone ? <p className="flex items-center gap-2"><Phone className="size-4 text-slate-400" aria-hidden="true" />{c.primaryContact.phone}</p> : null}
                <div className="flex flex-wrap gap-1 pt-1">
                  {c.primaryContact.roles.map((r) => <Badge key={r} tone={r === 'primary' ? 'blue' : 'neutral'}>{CONTACT_ROLE_LABEL[r]}</Badge>)}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No primary contact.</p>
            )}
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Management" />
          <CardBody className="pt-2">
            <Rows rows={[
              ['Account manager', c.accountManager?.displayName],
              ['Technical owner', c.technicalOwner?.displayName],
              ['Onboarding date', formatCalendarDate(c.onboardingDate)],
              ['Contract', c.contractStartDate || c.contractEndDate ? (
                <span key="c" className="inline-flex flex-wrap items-center justify-end gap-2">
                  {formatCalendarDate(c.contractStartDate)} → {formatCalendarDate(c.contractEndDate)}
                  {contractDays !== null && contractDays < 0 ? <Badge tone="red">Ended</Badge> : contractDays !== null && contractDays <= 60 ? <Badge tone="amber">Ends in {contractDays} days</Badge> : null}
                </span>
              ) : null],
              ['Created', `${formatDateTime(c.createdAt, tz)}${c.createdBy ? ` by ${c.createdBy.displayName}` : ''}`],
              ['Last updated', formatDateTime(c.updatedAt, tz)],
            ]} />
            {c.internalNotes ? (
              <div className="mt-4 rounded-lg bg-amber-50/60 p-3 ring-1 ring-amber-200/70">
                <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-amber-800">Internal notes</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{c.internalNotes}</p>
              </div>
            ) : null}
          </CardBody>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Licenses" icon={<KeyRound />} actions={can(me, 'licenses.manage') && !c.isSynthetic ? <Link href={`/licenses/new?clientId=${id}`} className="text-[13px] font-medium text-blue-700 hover:underline">New license</Link> : undefined} />
            <CardBody className="pt-1">
              {licenses.ok && licenses.data.items.length ? (
                <ul className="divide-y divide-slate-100 text-[13px]" data-testid="client-licenses">
                  {licenses.data.items.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span><Link href={`/licenses/${l.id}`} className="font-mono text-[12.5px] font-semibold text-blue-700 hover:underline">{l.code}</Link> <span className="text-slate-700">{l.displayName}</span></span>
                      <span className="inline-flex items-center gap-2"><LicenseStatusBadge status={l.status} /><span className="text-slate-600">{l.deploymentsUsed}/{l.maxDeployments}</span></span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-slate-500">No license yet. Deployments need an active license to get a package or enroll.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Deployment health" />
            <CardBody>
              <HealthBar health={c.health} total={c.deploymentCount} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Assigned technicians" icon={<UserRound />} description="Users limited to assigned clients who can see this client." />
            <CardBody>
              {c.assignedTechnicians.length ? (
                <ul className="space-y-1.5 text-sm text-slate-700">{c.assignedTechnicians.map((t) => <li key={t.id}>{t.displayName}</li>)}</ul>
              ) : (
                <p className="text-sm text-slate-500">None. Assign technicians from Settings → Users.</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader title="Recent activity" actions={<Link href={`/clients/${id}/activity`} className="text-[13px] font-medium text-blue-700 hover:underline">View all</Link>} />
        <CardBody>
          {activity.ok && activity.data.items.length ? (
            <ul className="space-y-2.5">
              {activity.data.items.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span><span className="font-mono text-[12.5px] text-slate-900">{e.action}</span> <span className="text-slate-500">by {e.actorDisplay}</span></span>
                  <span className="text-[12.5px] text-slate-500" title={formatDateTime(e.occurredAt, tz)}>{relativeTime(e.occurredAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No activity recorded yet.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
