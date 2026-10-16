import type { PsaInstanceDetail, PsaProviderDescriptor } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PsaInstanceForm } from '@/components/psa/psa-instance-form';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Configure PSA instance' };

export default async function ConfigurePsaPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'psa.write')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [res, providers] = await Promise.all([apiGet<PsaInstanceDetail>(`/psa-instances/${id}`), apiGet<PsaProviderDescriptor[]>('/psa-providers')]);
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) return <Card><ErrorState problem={res.problem} /></Card>;
  if (!providers.ok) return <Card><ErrorState problem={providers.problem} /></Card>;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'PSA Management', href: '/psa' }, { label: res.data.code, href: `/psa/${id}` }, { label: 'Configure' }]}
        title={`Configure ${res.data.displayName}`}
        description={`${res.data.providerName} for ${res.data.client.displayName}. The provider cannot be changed; create a new instance to switch providers. Changing the endpoint or authentication resets the connection to “Untested”.`}
      />
      <Card className="max-w-5xl">
        <CardBody className="sm:p-8">
          <PsaInstanceForm providers={providers.data} instance={res.data} />
        </CardBody>
      </Card>
    </>
  );
}
