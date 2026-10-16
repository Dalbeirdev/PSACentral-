import type { ServiceCategoryDto } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServiceForm } from '@/components/services/service-form';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'New service' };

export default async function NewServicePage() {
  const me = await requireActiveSession();
  if (!can(me, 'services.write')) notFound();
  const categories = await apiGet<ServiceCategoryDto[]>('/service-categories');
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Service Catalog', href: '/services' }, { label: 'New service' }]}
        title="New service"
        description="Add a service to the catalog. It becomes available to every client of this organization; assignment happens per client."
      />
      <Card className="max-w-5xl">
        <CardBody className="sm:p-8">
          {categories.ok ? <ServiceForm categories={categories.data} /> : <ErrorState problem={categories.problem} />}
        </CardBody>
      </Card>
    </>
  );
}
