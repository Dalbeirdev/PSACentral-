import type { ContactDto } from '@psacc/contracts';
import { Contact, Mail, Phone, Plus, Smartphone } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Badge, SyntheticBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { apiGet, can, requireActiveSession } from '@/lib/api-server';
import { CONTACT_ROLE_LABEL } from '@/lib/reference';

export const metadata: Metadata = { title: 'Client contacts' };

const MESSAGES: Record<string, string> = { added: 'Contact added.', updated: 'Contact updated.', removed: 'Contact removed.' };

export default async function ContactsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireActiveSession();
  const { id } = await params;
  const { saved } = await searchParams;
  const contacts = await apiGet<ContactDto[]>(`/clients/${id}/contacts`);
  const writer = can(me, 'clients.write');
  return (
    <div className="space-y-4">
      {saved && MESSAGES[saved] ? <Alert variant="success">{MESSAGES[saved]}</Alert> : null}
      <Card className="overflow-hidden">
        <CardHeader
          title="Contacts"
          description="Primary, technical, billing and escalation contacts for this client."
          actions={writer ? <ButtonLink href={`/clients/${id}/contacts/new`} variant="primary" size="sm"><Plus /> Add contact</ButtonLink> : null}
          className="pb-4"
        />
        {!contacts.ok ? (
          <ErrorState problem={contacts.problem} />
        ) : contacts.data.length === 0 ? (
          <EmptyState icon={<Contact />} title="No contacts" />
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {contacts.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 sm:px-6">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link href={`/clients/${id}/contacts/${c.id}`} className="font-semibold text-slate-900 hover:text-blue-700">{c.fullName}</Link>
                    {c.isSynthetic ? <SyntheticBadge /> : null}
                  </p>
                  {c.jobTitle ? <p className="text-[13px] text-slate-500">{c.jobTitle}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-slate-600">
                    <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1.5 hover:text-blue-700"><Mail className="size-3.5 text-slate-400" aria-hidden="true" />{c.email}</a>
                    {c.phone ? <span className="inline-flex items-center gap-1.5"><Phone className="size-3.5 text-slate-400" aria-hidden="true" />{c.phone}</span> : null}
                    {c.mobile ? <span className="inline-flex items-center gap-1.5"><Smartphone className="size-3.5 text-slate-400" aria-hidden="true" />{c.mobile}</span> : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {c.roles.map((r) => <Badge key={r} tone={r === 'primary' ? 'blue' : 'neutral'}>{CONTACT_ROLE_LABEL[r]}</Badge>)}
                  {writer ? <Link href={`/clients/${id}/contacts/${c.id}`} className="ml-2 text-[13px] font-medium text-blue-700 hover:underline">Edit<span className="sr-only"> {c.fullName}</span></Link> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
