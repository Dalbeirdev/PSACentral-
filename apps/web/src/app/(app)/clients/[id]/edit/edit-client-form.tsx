'use client';

import { CLIENT_STATUSES, type ClientDetail, clientUpdateSchema, SERVICE_STATUSES, type UserRef } from '@psacc/contracts';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import {
  CompanyFields,
  type CompanyForm,
  emptyCompany,
  emptyManagement,
  ManagementFields,
  type ManagementForm,
  type ReferenceLists,
  toForm,
} from '@/components/clients/client-fields';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { apiMutate, fieldErrors, zodErrors } from '@/lib/api-client';
import { CLIENT_STATUS_LABEL, SERVICE_STATUS_LABEL } from '@/lib/reference';

export function EditClientForm({ client, users, lists }: { client: ClientDetail; users: UserRef[]; lists: ReferenceLists }) {
  const router = useRouter();
  const [company, setCompany] = useState<CompanyForm>(() => toForm(emptyCompany(), client as unknown as Partial<Record<keyof CompanyForm, unknown>>));
  const [management, setManagement] = useState<ManagementForm>(() =>
    toForm(emptyManagement(), {
      accountManagerUserId: client.accountManager?.id,
      technicalOwnerUserId: client.technicalOwner?.id,
      onboardingDate: client.onboardingDate,
      contractStartDate: client.contractStartDate,
      contractEndDate: client.contractEndDate,
      internalNotes: client.internalNotes,
    }),
  );
  const [status, setStatus] = useState<string>(client.status);
  const [serviceStatus, setServiceStatus] = useState<string>(client.serviceStatus);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const payload = { version: client.version, company, management, status, serviceStatus };
    const parsed = clientUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      setError('Some fields need attention.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await apiMutate<ClientDetail>('PATCH', `/clients/${client.id}`, parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setStale(r.problem.type === 'urn:psacc:problem:stale-version');
      setError(r.problem.type === 'urn:psacc:problem:validation' ? 'Some fields need attention.' : (r.problem.detail ?? 'The client could not be saved.'));
      return;
    }
    // Dynamic pages are re-rendered on navigation, so the overview shows the saved values.
    router.push(`/clients/${client.id}?saved=1`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {error ? (
        <Alert variant="error" actions={stale ? <Button variant="secondary" size="sm" type="button" onClick={() => window.location.reload()}>Reload latest</Button> : undefined}>
          {error}
        </Alert>
      ) : null}
      <CompanyFields lists={lists} value={company} onChange={setCompany} errors={errors} />
      <ManagementFields value={management} onChange={setManagement} errors={errors} users={users} />
      <fieldset className="border-t border-slate-100 pt-6">
        <legend className="text-sm font-semibold text-slate-900">Status</legend>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <Field label="Client status" required error={errors.status}>
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
                {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{CLIENT_STATUS_LABEL[s]}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Service status" required error={errors.serviceStatus}>
            {(p) => (
              <Select {...p} value={serviceStatus} onChange={(e) => setServiceStatus(e.target.value)}>
                {SERVICE_STATUSES.map((s) => <option key={s} value={s}>{SERVICE_STATUS_LABEL[s]}</option>)}
              </Select>
            )}
          </Field>
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-6">
        <ButtonLink href={`/clients/${client.id}`} variant="secondary"><ArrowLeft /> Cancel</ButtonLink>
        <Button type="submit" loading={busy}>Save changes</Button>
      </div>
    </form>
  );
}
