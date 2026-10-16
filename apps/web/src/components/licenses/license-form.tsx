'use client';

import type { ClientSummary, LicenseDetail } from '@psacc/contracts';
import { licenseCreateSchema, licenseUpdateSchema } from '@psacc/contracts';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { apiMutate, fieldErrors, zodErrors } from '@/lib/api-client';

/** Create or edit a license (Module 14). Full page, inline validation, no dialog. */
export function LicenseForm({ clients, license, presetClientId }: { clients: Pick<ClientSummary, 'id' | 'code' | 'displayName' | 'status'>[]; license?: LicenseDetail; presetClientId?: string }) {
  const router = useRouter();
  const [clientId, setClientId] = useState(license?.client.id ?? presetClientId ?? '');
  const [displayName, setDisplayName] = useState(license?.displayName ?? '');
  const [startsAt, setStartsAt] = useState(license?.startsAt ?? new Date().toISOString().slice(0, 10));
  const [endsAt, setEndsAt] = useState(license?.endsAt ?? '');
  const [perpetual, setPerpetual] = useState(license ? license.endsAt === null : false);
  const [maxDeployments, setMax] = useState(String(license?.maxDeployments ?? 1));
  const [notes, setNotes] = useState(license?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    const base = { displayName: displayName.trim(), startsAt, endsAt: perpetual ? null : endsAt || null, maxDeployments: Number(maxDeployments), notes: notes.trim() || undefined };
    const parsed = license ? licenseUpdateSchema.safeParse({ version: license.version, ...base }) : licenseCreateSchema.safeParse({ clientId, ...base });
    if (!parsed.success) return setErrors(zodErrors(parsed.error.issues));
    setErrors({});
    setBusy(true);
    const r = license ? await apiMutate<LicenseDetail>('PATCH', `/licenses/${license.id}`, parsed.data) : await apiMutate<LicenseDetail>('POST', '/licenses', parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      return setProblem(r.problem.detail ?? r.problem.title ?? 'The license was not saved.');
    }
    router.push(`/licenses/${r.data.id}?saved=${license ? 'updated' : 'created'}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      {problem ? <Alert variant="error" title={problem} /> : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Client" required error={errors.clientId} className="sm:col-span-2">
          {(p) => (
            <Select {...p} value={clientId} disabled={!!license} onChange={(e) => setClientId(e.target.value)} data-testid="license-client">
              <option value="">Choose a client…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.displayName} ({c.code}){c.status !== 'active' ? ` · ${c.status}` : ''}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Plan name" required error={errors.displayName} hint="The entitlement this license grants, e.g. Help Desk Standard." className="sm:col-span-2">
          {(p) => <Input {...p} value={displayName} maxLength={120} onChange={(e) => setDisplayName(e.target.value)} data-testid="license-plan" />}
        </Field>
        <Field label="Starts" required error={errors.startsAt}>
          {(p) => <Input {...p} type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />}
        </Field>
        <Field label="Ends" error={errors.endsAt} hint={perpetual ? 'Perpetual: no end date.' : 'Deployments keep running after the end date; the license shows as expired and new packages are refused.'}>
          {(p) => (
            <div className="flex flex-wrap items-center gap-3">
              <Input {...p} type="date" value={endsAt} disabled={perpetual} onChange={(e) => setEndsAt(e.target.value)} className="max-w-[12rem]" data-testid="license-ends" />
              <label className="inline-flex items-center gap-2 text-[13px] text-slate-700"><input type="checkbox" checked={perpetual} onChange={(e) => setPerpetual(e.target.checked)} className="accent-blue-600" /> Perpetual</label>
            </div>
          )}
        </Field>
        <Field label="Maximum deployments" required error={errors.maxDeployments} hint="Appliances that may run under this license at the same time (decommissioned ones do not count).">
          {(p) => <Input {...p} type="number" min={1} max={1000} value={maxDeployments} onChange={(e) => setMax(e.target.value)} className="max-w-[8rem]" data-testid="license-max" />}
        </Field>
        <Field label="Notes" error={errors.notes} hint="Optional, internal." className="sm:col-span-2">
          {(p) => <Textarea {...p} value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} data-testid="license-save">{license ? 'Save changes' : 'Create license'}</Button>
        <ButtonLink href={license ? `/licenses/${license.id}` : '/licenses'} variant="secondary"><ArrowLeft /> Back</ButtonLink>
      </div>
    </form>
  );
}
