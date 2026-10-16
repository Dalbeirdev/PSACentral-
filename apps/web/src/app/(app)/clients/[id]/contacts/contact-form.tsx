'use client';

import { type ContactDto, contactSchema } from '@psacc/contracts';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ContactFields, type ContactForm as ContactFormValue, emptyContact, toForm } from '@/components/clients/client-fields';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { apiMutate, fieldErrors, zodErrors } from '@/lib/api-client';

export function ContactForm({ clientId, contact, canEdit }: { clientId: string; contact?: ContactDto; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState<ContactFormValue>(() => (contact ? toForm(emptyContact(), contact) : emptyContact()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const back = `/clients/${clientId}/contacts`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = contactSchema.safeParse(value);
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      return setError('Some fields need attention.');
    }
    setErrors({});
    setBusy(true);
    const r = contact
      ? await apiMutate<ContactDto>('PUT', `/clients/${clientId}/contacts/${contact.id}`, parsed.data)
      : await apiMutate<ContactDto>('POST', `/clients/${clientId}/contacts`, parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      return setError(r.problem.type === 'urn:psacc:problem:validation' ? (r.problem.errors?.[0]?.message ?? 'Some fields need attention.') : (r.problem.detail ?? 'The contact could not be saved.'));
    }
    router.push(`${back}?saved=${contact ? 'updated' : 'added'}`);
  }

  async function remove() {
    setBusy(true);
    const r = await apiMutate('DELETE', `/clients/${clientId}/contacts/${contact!.id}`);
    setBusy(false);
    if (!r.ok) {
      setConfirmDelete(false);
      return setError(r.problem.detail ?? 'The contact could not be removed.');
    }
    router.push(`${back}?saved=removed`);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={onSubmit} noValidate className="space-y-6">
        {error ? <Alert variant="error">{error}</Alert> : null}
        <fieldset disabled={!canEdit}>
          <ContactFields value={value} onChange={setValue} errors={errors} prefix="" />
        </fieldset>
        <p className="text-[13px] text-slate-500">Marking this contact as primary makes the current primary contact a regular contact.</p>
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-6">
          <ButtonLink href={back} variant="secondary"><ArrowLeft /> Back to contacts</ButtonLink>
          {canEdit ? <Button type="submit" loading={busy}>{contact ? 'Save contact' : 'Add contact'}</Button> : null}
        </div>
      </form>
      {contact && canEdit ? (
        <section className="border-t border-slate-100 pt-6" aria-labelledby="remove-heading">
          <h3 id="remove-heading" className="text-sm font-semibold text-slate-900">Remove contact</h3>
          <p className="mt-1 text-[13px] text-slate-500">The primary contact and the last remaining contact cannot be removed.</p>
          {!confirmDelete ? (
            <Button variant="secondary" className="mt-3" onClick={() => setConfirmDelete(true)}><Trash2 /> Remove…</Button>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50/50 p-3">
              <p className="mr-2 text-[13px] font-medium text-red-900">Remove {contact.fullName} from this client?</p>
              <Button variant="danger" size="sm" loading={busy} onClick={remove}>Yes, remove</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
