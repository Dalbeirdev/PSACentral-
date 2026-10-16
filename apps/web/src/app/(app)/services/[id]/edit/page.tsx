import type { ServiceCategoryDto, ServiceDetail } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServiceForm } from '@/components/services/service-form';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Edit service' };

export default async function EditServicePage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'services.write')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [res, categories] = await Promise.all([apiGet<ServiceDetail>(`/services/${id}`), apiGet<ServiceCategoryDto[]>('/service-categories')]);
  if (!res.ok && res.status === 404) notFound();
  if (!res.ok) return <Card><ErrorState problem={res.problem} /></Card>;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Service Catalog', href: '/services' }, { label: res.data.name, href: `/services/${id}` }, { label: 'Edit' }]}
        title={`Edit ${res.data.name}`}
        description={`${res.data.clientCount} client(s) are assigned this service. Changing its requirements marks their settings incomplete until they are completed; appliances are not changed.`}
      />
      <Card className="max-w-5xl">
        <CardBody className="sm:p-8">
          {categories.ok ? <ServiceForm categories={categories.data} service={res.data} /> : <ErrorState problem={categories.problem} />}
        </CardBody>
      </Card>
    </>
  );
}
