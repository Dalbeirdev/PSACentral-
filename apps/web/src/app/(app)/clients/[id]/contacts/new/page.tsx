import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { can, requireActiveSession } from '@/lib/api-server';
import { ContactForm } from '../contact-form';

export const metadata: Metadata = { title: 'Add contact' };

export default async function NewContactPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireActiveSession();
  if (!can(me, 'clients.write')) notFound();
  const { id } = await params;
  return (
    <Card className="max-w-3xl">
      <CardBody className="sm:p-8">
        <h2 className="mb-6 text-[15px] font-semibold text-slate-900">Add contact</h2>
        <ContactForm clientId={id} canEdit />
      </CardBody>
    </Card>
  );
}
