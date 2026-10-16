'use client';

import { DEFAULT_RETENTION_POLICY, RETENTION_DAYS_MAX, RETENTION_DAYS_MIN, type RetentionPolicyDto, type RetentionPurgeResult, retentionPolicySchema } from '@psacc/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, fieldErrors, zodErrors } from '@/lib/api-client';

/** Module 15 — retention of decommissioned deployments' operational metadata, and an explicit purge run. */
export function RetentionForm({ initial }: { initial: RetentionPolicyDto }) {
  const router = useRouter();
  const [days, setDays] = useState(String(initial.decommissionedMetadataDays));
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ variant: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'purge' | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = retentionPolicySchema.safeParse({ decommissionedMetadataDays: Number(days) });
    if (!parsed.success) {
      setError(zodErrors(parsed.error.issues).decommissionedMetadataDays ?? 'Enter a number of days.');
      return;
    }
    setBusy('save');
    const r = await apiMutate<RetentionPolicyDto>('PUT', '/settings/retention', parsed.data);
    setBusy(null);
    if (!r.ok) {
      setError(fieldErrors(r.problem).decommissionedMetadataDays);
      setNotice({ variant: 'error', text: r.problem.detail ?? 'The policy was not saved.' });
      return;
    }
    setError(undefined);
    setNotice({ variant: 'success', text: `Retention saved: metadata of decommissioned deployments is purged ${r.data.decommissionedMetadataDays} days after decommissioning.` });
    router.refresh();
  }

  async function purge() {
    setBusy('purge');
    const r = await apiMutate<RetentionPurgeResult>('POST', '/settings/retention/purge');
    setBusy(null);
    setConfirmPurge(false);
    if (!r.ok) return setNotice({ variant: 'error', text: r.problem.detail ?? 'The purge did not run.' });
    setNotice({ variant: r.data.purgedDeployments ? 'success' : 'info', text: r.data.purgedDeployments ? `Purged the retained metadata of ${r.data.purgedDeployments} deployment(s); each purge is in the audit log.` : 'Nothing was due: no decommissioned deployment has passed the retention period.' });
    router.refresh();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      {notice ? <div data-testid="retention-notice"><Alert variant={notice.variant}>{notice.text}</Alert></div> : null}
      <Field label="Keep decommissioned deployments’ metadata for (days)" required error={error} hint={`Between ${RETENTION_DAYS_MIN} and ${RETENTION_DAYS_MAX} days. Reports, heartbeats, the table inventory, the health timeline and the command history are deleted after this period; the deployment record, its identity history and the audit trail stay.`} className="max-w-md">
        {(p) => <Input {...p} type="number" inputMode="numeric" min={RETENTION_DAYS_MIN} max={RETENTION_DAYS_MAX} value={days} onChange={(e) => { setDays(e.target.value); setError(undefined); }} data-testid="retention-days" />}
      </Field>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Button type="submit" variant="primary" loading={busy === 'save'} disabled={busy !== null} data-testid="retention-save">Save policy</Button>
        <Button type="button" variant="ghost" onClick={() => { setDays(String(DEFAULT_RETENTION_POLICY.decommissionedMetadataDays)); setError(undefined); }} disabled={busy !== null}>Reset to default ({DEFAULT_RETENTION_POLICY.decommissionedMetadataDays} days)</Button>
        {!confirmPurge ? (
          <Button type="button" variant="secondary" onClick={() => setConfirmPurge(true)} disabled={busy !== null} data-testid="retention-purge">Purge what is due now</Button>
        ) : null}
      </div>
      {confirmPurge ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4" role="group" aria-label="Confirm purge">
          <p className="text-sm font-semibold text-slate-900">Purge now?</p>
          <p className="mt-1 text-[12.5px] text-slate-700">Runs the hourly retention sweep immediately for this organization: only deployments decommissioned longer than {days || initial.decommissionedMetadataDays} days are affected. Each purge is audited.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="danger" onClick={purge} loading={busy === 'purge'} disabled={busy !== null} data-testid="retention-purge-confirm">Yes, purge</Button>
            <Button type="button" variant="ghost" onClick={() => setConfirmPurge(false)} disabled={busy !== null}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </form>
  );
}
