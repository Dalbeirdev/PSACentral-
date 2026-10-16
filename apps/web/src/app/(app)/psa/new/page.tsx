import type { ClientDetail, PsaProviderDescriptor } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PsaInstanceForm } from '@/components/psa/psa-instance-form';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'New PSA instance' };

export default async function NewPsaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  if (!can(me, 'psa.write')) notFound();
  const { clientId } = await searchParams;
  const [providers, client] = await Promise.all([
    apiGet<PsaProviderDescriptor[]>('/psa-providers'),
    clientId && /^[0-9a-f-]{36}$/i.test(clientId) ? apiGet<ClientDetail>(`/clients/${clientId}`) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'PSA Management', href: '/psa' }, { label: 'New PSA instance' }]}
        title="New PSA instance"
        description="Add a PSA instance to a client. A client can have several. Credentials are entered later, on the client’s appliance."
      />
      <Card className="max-w-5xl">
        <CardBody className="sm:p-8">
          {providers.ok ? (
            <PsaInstanceForm providers={providers.data} presetClient={client?.ok ? { id: client.data.id, code: client.data.code, displayName: client.data.displayName } : null} />
          ) : (
            <ErrorState problem={providers.problem} />
          )}
        </CardBody>
      </Card>
    </>
  );
}
