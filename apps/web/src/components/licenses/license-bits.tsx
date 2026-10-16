'use client';

import { LICENSE_STATUS_LABELS, type LicenseDetail, type LicenseStatus, type LicenseSummary } from '@psacc/contracts';
import { Ban, PauseCircle, PlayCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate } from '@/lib/api-client';

const TONE: Record<LicenseStatus, 'emerald' | 'amber' | 'neutral' | 'red'> = { active: 'emerald', suspended: 'amber', expired: 'neutral', revoked: 'red' };

export function LicenseStatusBadge({ status }: { status: LicenseStatus }) {
  return <Badge tone={TONE[status]} data-testid="license-status">{LICENSE_STATUS_LABELS[status]}</Badge>;
}

/** "Ends in 12 days" / "Ended 4 days ago" / "Perpetual", with the amber tone when expiring. */
export function TermBadge({ l }: { l: Pick<LicenseSummary, 'endsAt' | 'daysRemaining' | 'expiring' | 'status'> }) {
  if (l.endsAt === null) return <Badge tone="blue">Perpetual</Badge>;
  if (l.daysRemaining === null) return null;
  if (l.daysRemaining < 0) return <Badge tone={l.status === 'active' ? 'red' : 'neutral'}>Ended {-l.daysRemaining} day(s) ago</Badge>;
  if (l.expiring) return <Badge tone="amber">Ends in {l.daysRemaining} day(s)</Badge>;
  return <span className="text-[12.5px] text-slate-500">{l.daysRemaining} days left</span>;
}

/** Suspend / resume / revoke with an inline reason (no dialog). */
export function LicenseActions({ license }: { license: LicenseDetail }) {
  const router = useRouter();
  const [action, setAction] = useState<'suspend' | 'resume' | 'revoke' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run() {
    if (!action) return;
    if (reason.trim().length < 3) return setError('Give a reason (at least 3 characters).');
    setBusy(true);
    const r = await apiMutate<LicenseDetail>('POST', `/licenses/${license.id}/${action}`, { reason: reason.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The change was not applied.');
    setNotice({ suspend: 'License suspended. Its deployments can no longer get packages or enroll; running appliances are not touched until you suspend them.', resume: 'License active again.', revoke: 'License revoked permanently.' }[action]);
    setAction(null);
    setReason('');
    router.refresh();
  }

  const can = { suspend: license.status === 'active', resume: license.status === 'suspended', revoke: license.status !== 'revoked' };
  return (
    <div className="space-y-3">
      {notice ? <Alert variant="info" title={notice} /> : null}
      {!action ? (
        <div className="flex flex-wrap gap-2">
          {can.suspend ? <Button variant="secondary" size="sm" onClick={() => setAction('suspend')} data-testid="license-suspend"><PauseCircle /> Suspend license</Button> : null}
          {can.resume ? <Button variant="secondary" size="sm" onClick={() => setAction('resume')} data-testid="license-resume"><PlayCircle /> Resume license</Button> : null}
          {can.revoke ? <Button variant="danger" size="sm" onClick={() => setAction('revoke')} data-testid="license-revoke"><Ban /> Revoke license</Button> : null}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4" data-testid="license-action-panel">
          <p className="text-sm font-semibold text-slate-900">{{ suspend: 'Suspend this license', resume: 'Resume this license', revoke: 'Revoke this license permanently' }[action]}</p>
          <p className="mt-1 text-[12.5px] text-slate-600">
            {action === 'suspend' ? 'Deployments bound to it can no longer generate packages or enroll. Appliances already running are not changed by this; suspend them individually when needed.' : action === 'resume' ? 'Packages and enrollment work again for its deployments.' : 'This cannot be undone. Bound deployments keep running until they are suspended or decommissioned, but no new package or enrollment is possible.'}
          </p>
          <Field label="Reason (kept in the audit log)" required error={error} className="mt-3 max-w-xl">
            {(p) => <Input {...p} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} data-testid="license-reason" />}
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant={action === 'revoke' ? 'danger' : 'primary'} onClick={run} loading={busy} data-testid="license-confirm">Confirm</Button>
            <Button variant="secondary" onClick={() => { setAction(null); setError(undefined); }} disabled={busy}>Back</Button>
          </div>
        </div>
      )}
    </div>
  );
}
