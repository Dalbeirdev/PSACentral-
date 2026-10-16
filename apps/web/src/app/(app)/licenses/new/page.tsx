import type { ClientSummary, Paged } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LicenseForm } from '@/components/licenses/license-form';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'New license' };

export default async function NewLicensePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'licenses.manage')) notFound();
  const sp = await searchParams;
  const preset = typeof sp.clientId === 'string' ? sp.clientId : undefined;
  const clients = await apiGet<Paged<ClientSummary>>('/clients?pageSize=100');
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Licenses', href: '/licenses' }, { label: 'New license' }]}
        title="New license"
        description="A license gets its own identifier (LIC-…) and is one of the identifiers an appliance carries. Deployments bind to it; packages and enrollment need it to be active with free capacity."
      />
      <Card className="max-w-4xl">
        <CardBody className="sm:p-8">
          {clients.ok ? <LicenseForm clients={clients.data.items.filter((c) => c.status !== 'offboarded')} presetClientId={preset} /> : <ErrorState problem={clients.problem} />}
        </CardBody>
      </Card>
    </>
  );
}
