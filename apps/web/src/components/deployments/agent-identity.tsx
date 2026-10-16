'use client';

import type { DeploymentDetail } from '@psacc/contracts';
import { Ban, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { apiMutate } from '@/lib/api-client';
// Exact times only: relative times drift between server render and hydration (React #418).
import { formatDateTime } from '@/lib/format';

const STATUS: Record<string, { tone: 'emerald' | 'neutral' | 'red'; label: string }> = {
  active: { tone: 'emerald', label: 'Active' },
  superseded: { tone: 'neutral', label: 'Replaced by renewal' },
  revoked: { tone: 'red', label: 'Revoked' },
};

/** The agent's machine certificate (mTLS identity), its history, and inline revocation. */
export function AgentIdentity({ d, canRevoke, timezone }: { d: DeploymentDetail; canRevoke: boolean; timezone: string }) {
  const router = useRouter();
  const active = d.agentCertificates.find((c) => c.status === 'active');
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function revoke() {
    if (reason.trim().length < 3) return setError('Give a reason (at least 3 characters).');
    setBusy(true);
    const r = await apiMutate<DeploymentDetail>('POST', `/deployments/${d.id}/agent-certificate/revoke`, { reason: reason.trim() });
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The certificate was not revoked.');
    setRevoking(false);
    setNotice('Certificate revoked. The gateway refuses it from now on; the appliance keeps working locally. To reconnect it, generate a new package and install it.');
    router.refresh();
  }

  if (!d.agentCertificates.length) {
    return <p className="text-sm text-slate-500">No machine certificate yet. The agent receives one when it enrolls with the package’s single-use token.</p>;
  }
  return (
    <div className="space-y-4">
      {notice ? <Alert variant="info" title="Certificate revoked">{notice}</Alert> : null}
      {active ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 px-4 py-3" data-testid="active-certificate">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">
            <ShieldCheck className="size-4 text-emerald-600" aria-hidden="true" /> Active machine certificate <Badge tone="emerald">mTLS</Badge>
          </p>
          <dl className="mt-2 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
            <div><dt className="text-slate-500">Serial</dt><dd className="break-all font-mono text-[12.5px] text-slate-800">{active.serial}</dd></div>
            <div><dt className="text-slate-500">Fingerprint (SHA-256)</dt><dd className="break-all font-mono text-[12.5px] text-slate-800">{active.fingerprint.slice(0, 32)}…</dd></div>
            <div><dt className="text-slate-500">Valid until</dt><dd className="font-medium text-slate-800">{formatDateTime(active.notAfter, timezone)}</dd></div>
            <div><dt className="text-slate-500">Last seen</dt><dd className="font-medium text-slate-800">{active.lastSeenAt ? formatDateTime(active.lastSeenAt, timezone, { seconds: true }) : 'Never'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-slate-500">Subject</dt><dd className="break-all font-mono text-[12.5px] text-slate-800">{active.subject}</dd></div>
          </dl>
          {canRevoke && !revoking ? (
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => setRevoking(true)}><Ban /> Revoke certificate</Button>
          ) : null}
          {revoking ? (
            <div className="mt-3 rounded-lg border border-red-100 bg-white px-4 py-3" role="group" aria-label="Revoke certificate">
              <p className="text-sm font-semibold text-red-900">Revoke this machine certificate?</p>
              <p className="mt-0.5 text-[13px] text-red-900/80">The agent can no longer reach the Control Plane. The appliance keeps running locally. Re-enrolling needs a new package (new installation identity and token).</p>
              <Field label="Reason" error={error} required className="mt-3 max-w-xl">
                {(p) => <Textarea {...p} rows={2} maxLength={200} value={reason} onChange={(e) => { setReason(e.target.value); setError(undefined); }} />}
              </Field>
              <div className="mt-3 flex gap-2">
                <Button variant="danger" onClick={revoke} loading={busy} disabled={busy}>Yes, revoke</Button>
                <Button variant="ghost" onClick={() => { setRevoking(false); setError(undefined); }} disabled={busy}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <caption className="sr-only">Certificate history</caption>
          <thead><tr className="text-slate-500"><th className="py-1.5 pr-4 font-medium">Serial</th><th className="py-1.5 pr-4 font-medium">Status</th><th className="py-1.5 pr-4 font-medium">Issued</th><th className="py-1.5 font-medium">Valid until</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {d.agentCertificates.map((c) => (
              <tr key={c.id}>
                <td className="py-1.5 pr-4 font-mono text-[12px]">{c.serial.slice(0, 16)}…</td>
                <td className="py-1.5 pr-4"><Badge tone={STATUS[c.status]!.tone}>{STATUS[c.status]!.label}</Badge>{c.revokeReason ? <span className="ml-2 text-[12px] text-slate-500">{c.revokeReason}</span> : null}</td>
                <td className="py-1.5 pr-4 text-slate-700">{formatDateTime(c.issuedAt, timezone)} · {c.issuedVia}</td>
                <td className="py-1.5 text-slate-700">{formatDateTime(c.notAfter, timezone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
