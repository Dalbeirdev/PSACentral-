'use client';

import type { DeploymentDetail } from '@psacc/contracts';
import { PauseCircle, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

/**
 * Suspend / resume a deployment (Module 14). Reversible: the lifecycle keeps the previous state; an
 * enrolled appliance receives a signed `suspend` / `resume` command that pauses or resumes its PSA
 * work while data and the local UI stay. Inline confirmation with a reason; no dialog.
 */
export function LifecycleActions({ d, timezone }: { d: DeploymentDetail; timezone: string }) {
  const router = useRouter();
  const suspended = d.lifecycleState === 'suspended';
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run() {
    if (reason.trim().length < 3) return setError('Give a reason (at least 3 characters).');
    setBusy(true);
    const r = await apiMutate<DeploymentDetail>('POST', `/deployments/${d.id}/${suspended ? 'resume' : 'suspend'}`, { reason: reason.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The change was not applied.');
    setNotice(suspended
      ? `Resumed: the deployment is ${r.data.lifecycleState} again. An enrolled appliance receives a signed resume command with its next heartbeat.`
      : 'Suspended. Packages, enrollment and remote operations are blocked; an enrolled appliance receives a signed suspend command that pauses its PSA work (data and the local admin stay).');
    setOpen(false);
    setReason('');
    router.refresh();
  }

  if (d.lifecycleState === 'decommissioned') return null;
  const licenseBlocksResume = suspended && (!d.licenseDetail || d.licenseDetail.status !== 'active');
  return (
    <div className="space-y-3" data-testid="lifecycle-actions">
      {notice ? <Alert variant="info" title={notice} /> : null}
      {suspended && d.suspension ? (
        <Alert variant="warning" title={`Suspended since ${formatDateTime(d.suspension.at, timezone)}${d.suspension.by ? ` by ${d.suspension.by}` : ''}`}>
          Reason: {d.suspension.reason}. It was <em>{d.suspension.fromState.replace(/_/g, ' ')}</em> before; resuming returns it to that state.
          {licenseBlocksResume ? <> Resume needs an active license — see <Link href={d.licenseDetail ? `/licenses/${d.licenseDetail.id}` : '/licenses'} className="underline">the license</Link>.</> : null}
        </Alert>
      ) : null}
      {!open ? (
        <Button variant={suspended ? 'primary' : 'secondary'} size="sm" onClick={() => setOpen(true)} disabled={licenseBlocksResume} data-testid={suspended ? 'resume-deployment' : 'suspend-deployment'}>
          {suspended ? <><PlayCircle /> Resume deployment</> : <><PauseCircle /> Suspend deployment</>}
        </Button>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4" data-testid="lifecycle-panel">
          <p className="text-sm font-semibold text-slate-900">{suspended ? 'Resume this deployment' : 'Suspend this deployment'}</p>
          <p className="mt-1 text-[12.5px] text-slate-600">
            {suspended
              ? 'The previous lifecycle state returns; an enrolled appliance resumes PSA tests and synchronization after its next heartbeat.'
              : 'Reversible. No package, enrollment or remote operation is possible while suspended. An enrolled appliance pauses PSA tests and synchronization; tickets, data and its local admin stay available and nothing is deleted.'}
          </p>
          <Field label="Reason (kept in the audit log)" required error={error} className="mt-3 max-w-xl">
            {(p) => <Input {...p} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="lifecycle-reason" />}
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={run} loading={busy} data-testid="lifecycle-confirm">{suspended ? 'Resume' : 'Suspend'}</Button>
            <Button variant="secondary" onClick={() => { setOpen(false); setError(undefined); }} disabled={busy}>Back</Button>
          </div>
        </div>
      )}
    </div>
  );
}
