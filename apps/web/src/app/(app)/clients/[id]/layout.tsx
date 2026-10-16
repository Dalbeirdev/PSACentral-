import { Globe, MapPin, Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { ClientStatusBadge, ServiceStatusBadge } from '@/components/clients/badges';
import { SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Breadcrumbs } from '@/components/ui/page-header';
import { can, requireActiveSession } from '@/lib/api-server';
import { getClient } from '@/lib/clients';
import { countryName } from '@/lib/reference';
import { ClientTabs } from './client-tabs';

export default async function ClientLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const c = await getClient(id);
  const tabs = [
    { href: `/clients/${id}`, label: 'Overview', exact: true },
    { href: `/clients/${id}/contacts`, label: 'Contacts', count: c.counts.contacts },
    { href: `/clients/${id}/services`, label: 'Services', count: c.counts.services },
    ...(can(me, 'psa.read') ? [{ href: `/clients/${id}/psa`, label: 'PSA', count: c.counts.psaInstances }] : []),
    ...(can(me, 'deployments.read') ? [{ href: `/clients/${id}/deployments`, label: 'Deployments', count: c.counts.deployments }] : []),
    ...(can(me, 'health.read') ? [{ href: `/clients/${id}/health`, label: 'Health' }] : []),
    { href: `/clients/${id}/activity`, label: 'Activity' },
  ];
  const location = [c.city, countryName(c.countryCode)].filter((x) => x && x !== '—').join(', ');

  return (
    <>
      <Breadcrumbs items={[{ label: 'Clients', href: '/clients' }, { label: c.displayName }]} className="mb-3" />
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] sm:leading-9">{c.displayName}</h1>
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200">{c.code}</span>
            {c.isSynthetic ? <SyntheticBadge /> : null}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
            <span>{c.legalName}</span>
            <span>Ref <span className="font-mono text-slate-700">{c.clientReference}</span></span>
            {location ? <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden="true" />{location}</span> : null}
            {c.website ? (
              <a href={c.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                <Globe className="size-3.5" aria-hidden="true" />{new URL(c.website).hostname}
              </a>
            ) : null}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ClientStatusBadge status={c.status} />
            <ServiceStatusBadge status={c.serviceStatus} />
          </div>
        </div>
        {can(me, 'clients.write') ? (
          <ButtonLink href={`/clients/${id}/edit`} variant="secondary">
            <Pencil /> Edit client
          </ButtonLink>
        ) : null}
      </div>
      <ClientTabs tabs={tabs} />
      {children}
    </>
  );
}
