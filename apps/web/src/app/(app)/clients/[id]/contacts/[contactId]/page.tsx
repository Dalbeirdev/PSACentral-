import type { ContactDto } from '@psacc/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Card, CardBody } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { ContactForm } from '../contact-form';

export const metadata: Metadata = { title: 'Contact' };

export default async function ContactPage({ params }: { params: Promise<{ id: string; contactId: string }> }) {
  const me = await requireActiveSession();
  const { id, contactId } = await params;
  const contacts = await apiGet<ContactDto[]>(`/clients/${id}/contacts`);
  if (!contacts.ok) return <Card><ErrorState problem={contacts.problem} /></Card>;
  const contact = contacts.data.find((c) => c.id === contactId);
  if (!contact) notFound();
  return (
    <Card className="max-w-3xl">
      <CardBody className="sm:p-8">
        <h2 className="mb-6 text-[15px] font-semibold text-slate-900">{contact.fullName}</h2>
        <ContactForm key={contact.updatedAt} clientId={id} contact={contact} canEdit={can(me, 'clients.write')} />
      </CardBody>
    </Card>
  );
}
