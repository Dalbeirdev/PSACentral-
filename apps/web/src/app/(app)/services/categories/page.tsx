import type { ServiceCategoryDto } from '@psacc/contracts';
import { Pencil, Plus, Tags } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CategoryForm } from '@/components/services/category-form';
import { Alert } from '@/components/ui/alert';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { formatDateTime } from '@/lib/format';

export const metadata: Metadata = { title: 'Service categories' };

const SAVED: Record<string, string> = {
  created: 'Category created and recorded in the activity history.',
  updated: 'Category saved and recorded in the activity history.',
  deleted: 'Category deleted and recorded in the activity history.',
};

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  const { saved } = await searchParams;
  const categories = await apiGet<ServiceCategoryDto[]>('/service-categories');
  const canWrite = can(me, 'services.write');
  const tz = me.user.timezone;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Service Catalog', href: '/services' }, { label: 'Categories' }]}
        title="Service categories"
        description="Categories group the catalog in the onboarding wizard and on client pages. Only empty categories can be deleted."
      />
      {saved && SAVED[saved] ? <Alert variant="success" className="mb-4">{SAVED[saved]}</Alert> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader title="Categories" icon={<Tags />} className="pb-4" />
          {!categories.ok ? (
            <ErrorState problem={categories.problem} />
          ) : categories.data.length === 0 ? (
            <EmptyState icon={<Tags />} title="No categories yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Category</Th>
                  <Th>Order</Th>
                  <Th>Services</Th>
                  <Th>Updated</Th>
                  {canWrite ? <Th><span className="sr-only">Actions</span></Th> : null}
                </tr>
              </thead>
              <tbody>
                {categories.data.map((c) => (
                  <Tr key={c.id}>
                    <Td>
                      <span className="block font-semibold text-slate-900">{c.name}</span>
                      <span className="font-mono text-[12.5px] text-slate-500">{c.key}</span>
                    </Td>
                    <Td className="text-[13px] text-slate-600">{c.sortOrder}</Td>
                    <Td className="text-[13px] text-slate-600">
                      <Link href={`/services?category=${c.key}`} className="text-blue-700 hover:underline">{c.serviceCount} service{c.serviceCount === 1 ? '' : 's'}</Link>
                      {c.serviceCount !== c.activeServiceCount ? <span className="text-slate-500"> ({c.serviceCount - c.activeServiceCount} inactive)</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-[13px] text-slate-600">{formatDateTime(c.updatedAt, tz)}</Td>
                    {canWrite ? (
                      <Td className="text-right">
                        <Link href={`/services/categories/${c.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-700 hover:underline"><Pencil className="size-3.5" aria-hidden="true" /> Edit<span className="sr-only"> {c.name}</span></Link>
                      </Td>
                    ) : null}
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {canWrite ? (
          <Card>
            <CardHeader title="New category" icon={<Plus />} />
            <CardBody>
              <CategoryForm />
            </CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}
