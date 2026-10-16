'use client';

import type { DeploymentDetail, DeploymentRemovalResult } from '@psacc/contracts';
import { Archive, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, fieldErrors } from '@/lib/api-client';

/**
 * Module 15 — decommissioning on a full page (no dialog). Final: the deployment's identity is retired on the
 * Control Plane; the appliance is told at its next heartbeat and keeps its data until the host operator
 * removes it. The operator gives a reason and types the deployment ID to confirm.
 */
export function DecommissionForm({ d }: { d: DeploymentDetail }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enrolled = ['enrolled', 'verified'].includes(d.lifecycleState) || (d.lifecycleState === 'suspended' && !!d.enrolledAt);

  async function run() {
    const next: Record<string, string> = {};
    if (reason.trim().length < 3) next.reason = 'Give a reason (at least 3 characters).';
    if (confirm.trim().toUpperCase() !== d.code.toUpperCase()) next.confirmCode = `Type ${d.code} exactly to confirm.`;
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const r = await apiMutate<DeploymentDetail>('POST', `/deployments/${d.id}/decommission`, { reason: reason.trim(), confirmCode: confirm.trim() });
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setNotice(r.problem.detail ?? 'The deployment was not decommissioned.');
      return;
    }
    router.push(`/deployments/${d.id}?saved=decommissioned`);
    router.refresh();
  }

  return (
    <div className="space-y-4" data-testid="decommission-form">
      {notice ? <Alert variant="error" title={notice} /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-4">
          <p className="text-sm font-semibold text-red-900">What happens on the Control Plane (now)</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-slate-700">
            <li>The machine certificate is revoked; the gateway answers <em>decommissioned</em> from the next request on.</li>
            <li>The enrollment token and the usable package are revoked and the archive is purged; no new package can be generated.</li>
            <li>Open remote commands are cancelled; no command can be issued any more.</li>
            <li>The record becomes <strong>Decommissioned</strong> (final) and frees its license slot. Why, by whom and what was retired is audited.</li>
            <li>Retained metadata (reports, heartbeats, inventory, commands) is purged after the organization’s retention period; the record can then be removed.</li>
          </ul>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">What happens on the client’s host (never remotely)</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-slate-700">
            {enrolled ? (
              <>
                <li>At its next heartbeat the appliance learns that its identity was retired: it stops PSA connection tests and ticket synchronization and no longer reports.</li>
                <li>Its local admin shows <em>Decommissioned by the provider</em> and the removal instructions.</li>
              </>
            ) : (
              <li>No appliance has enrolled for this deployment, so nothing changes on any host.</li>
            )}
            <li><strong>Nothing is deleted on the host.</strong> Tickets, data, backups and credentials stay until the operator runs <code className="font-mono text-[12px]">scripts/uninstall.sh --wipe</code> from the package folder.</li>
            <li>The Control Plane has no access to the client’s network; it cannot and will not wipe anything.</li>
          </ul>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Reason (kept in the audit log)" required error={errors.reason}>
          {(p) => <Input {...p} value={reason} maxLength={200} onChange={(e) => { setReason(e.target.value); setErrors((x) => ({ ...x, reason: '' })); }} data-testid="decommission-reason" />}
        </Field>
        <Field label={`Type ${d.code} to confirm`} required error={errors.confirmCode} hint="The deployment ID, exactly as shown in the identity card.">
          {(p) => <Input {...p} value={confirm} maxLength={20} autoComplete="off" onChange={(e) => { setConfirm(e.target.value); setErrors((x) => ({ ...x, confirmCode: '' })); }} data-testid="decommission-confirm" />}
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" onClick={run} loading={busy} disabled={busy} data-testid="decommission-submit"><Archive /> Decommission {d.code}</Button>
        <Button variant="secondary" onClick={() => router.push(`/deployments/${d.id}`)} disabled={busy}>Back to the overview</Button>
      </div>
    </div>
  );
}

/** Removal of a decommissioned record from the Control Plane (inline typed confirmation; audited). */
export function RemoveDeployment({ d }: { d: DeploymentDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function run() {
    if (confirm.trim().toUpperCase() !== d.code.toUpperCase()) return setError(`Type ${d.code} exactly to confirm.`);
    setBusy(true);
    const r = await apiMutate<DeploymentRemovalResult>('DELETE', `/deployments/${d.id}`, { confirmCode: confirm.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The deployment was not removed.');
    router.push('/deployments');
    router.refresh();
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="remove-deployment"><Trash2 /> Remove from the Control Plane</Button>
    );
  }
  return (
    <div className="rounded-xl border border-red-200 bg-red-50/50 p-4" role="group" aria-label="Remove deployment" data-testid="remove-panel">
      <p className="text-sm font-semibold text-red-900">Remove {d.code} from the Control Plane?</p>
      <p className="mt-1 text-[12.5px] text-slate-700">
        Deletes the record with its identity history, packages, reports, inventory and command history. The audit trail stays. Nothing on the client’s host is touched.
        {d.decommission && !d.decommission.metadataPurgedAt ? ' The retention period has not ended yet; removing now deletes the retained metadata early.' : ''}
      </p>
      <Field label={`Type ${d.code} to confirm`} required error={error} className="mt-3 max-w-sm">
        {(p) => <Input {...p} value={confirm} maxLength={20} autoComplete="off" onChange={(e) => { setConfirm(e.target.value); setError(undefined); }} data-testid="remove-confirm" />}
      </Field>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="danger" onClick={run} loading={busy} disabled={busy} data-testid="remove-submit">Yes, remove</Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setError(undefined); }} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}
