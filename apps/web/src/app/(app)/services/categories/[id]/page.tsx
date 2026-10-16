import type { ServiceCategoryDto } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CategoryDelete, CategoryForm } from '@/components/services/category-form';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Edit category' };

export default async function EditCategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'services.write')) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const categories = await apiGet<ServiceCategoryDto[]>('/service-categories');
  if (!categories.ok) return <Card><ErrorState problem={categories.problem} /></Card>;
  const category = categories.data.find((c) => c.id === id);
  if (!category) notFound();
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Service Catalog', href: '/services' }, { label: 'Categories', href: '/services/categories' }, { label: category.name }]}
        title={`Edit ${category.name}`}
        description={`${category.serviceCount} service(s) in this category.`}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="sm:p-8">
            <CategoryForm category={category} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Delete" description="Removes the category from the catalog." />
          <CardBody>
            <CategoryDelete category={category} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
