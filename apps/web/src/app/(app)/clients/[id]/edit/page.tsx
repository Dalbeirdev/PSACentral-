import type { UserRef } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { getClient } from '@/lib/clients';
import { referenceLists } from '@/lib/reference';
import { EditClientForm } from './edit-client-form';

export const metadata: Metadata = { title: 'Edit client' };

export default async function EditClientPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'clients.write')) notFound();
  const { id } = await params;
  const [c, users] = await Promise.all([getClient(id), apiGet<UserRef[]>('/directory/users')]);
  return (
    <Card>
      <CardBody className="sm:p-8">
        <h2 className="mb-6 text-[15px] font-semibold text-slate-900">Edit client details</h2>
        <EditClientForm client={c} users={users.ok ? users.data : []} lists={referenceLists()} />
      </CardBody>
    </Card>
  );
}
