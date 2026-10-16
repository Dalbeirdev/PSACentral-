'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiMutate } from '@/lib/api-client';

/** Moves one of the client's deployments onto this PSA instance (inline confirmation, no dialog). */
export function DeploymentBinding({ instanceId, deploymentId, deploymentCode, disabled }: { instanceId: string; deploymentId: string; deploymentCode: string; disabled: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bind() {
    setBusy(true);
    setError(null);
    const r = await apiMutate('PUT', `/deployments/${deploymentId}/psa-instance`, { psaInstanceId: instanceId });
    setBusy(false);
    if (!r.ok) {
      setError(r.problem.errors?.[0]?.message ?? r.problem.detail ?? 'The deployment could not be associated.');
      setConfirm(false);
      return;
    }
    router.refresh();
  }

  if (error) return <Alert variant="error" className="py-2 text-[13px]">{error}</Alert>;
  if (!confirm) {
    return (
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setConfirm(true)}>
        Use this instance
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-lg bg-amber-50 px-2 py-1 ring-1 ring-amber-200">
      <span className="text-[12.5px] text-amber-900">Move {deploymentCode} to this PSA instance?</span>
      <Button size="sm" loading={busy} onClick={bind}>Yes, move</Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
    </span>
  );
}
