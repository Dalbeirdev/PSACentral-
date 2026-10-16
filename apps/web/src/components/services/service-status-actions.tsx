'use client';

import type { ServiceDetail } from '@psacc/contracts';
import { CirclePause, CirclePlay } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiMutate } from '@/lib/api-client';

/** Activate / deactivate with an inline confirmation that states the consequences (no dialog). */
export function ServiceStatusActions({ service }: { service: ServiceDetail }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deactivating = service.isActive;

  async function run() {
    setBusy(true);
    setError(null);
    const r = await apiMutate<ServiceDetail>('POST', `/services/${service.id}/${deactivating ? 'deactivate' : 'activate'}`, { version: service.version });
    setBusy(false);
    setConfirm(false);
    if (!r.ok) return setError(r.problem.detail ?? 'The service status could not be changed.');
    router.push(`/services/${service.id}?saved=${deactivating ? 'deactivated' : 'activated'}`);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      {error ? <Alert variant="error" className="py-2 text-[13px]">{error}</Alert> : null}
      {!confirm ? (
        <Button variant={deactivating ? 'secondary' : 'primary'} onClick={() => setConfirm(true)} disabled={deactivating && service.isDefault} title={deactivating && service.isDefault ? 'Default services must stay active; remove the default flag first.' : undefined}>
          {deactivating ? <><CirclePause /> Deactivate</> : <><CirclePlay /> Activate</>}
        </Button>
      ) : (
        <div className="rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200" role="group" aria-label={deactivating ? 'Confirm deactivation' : 'Confirm activation'}>
          <p className="text-[13px] text-amber-900">
            {deactivating
              ? `Deactivate ${service.name}? It can no longer be assigned. ${service.clientCount ? `${service.clientCount} client(s) keep it until it is removed from them; their appliances are not changed.` : 'No client is assigned to it.'}`
              : `Activate ${service.name}? It becomes available for assignment again.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant={deactivating ? 'danger' : 'primary'} loading={busy} onClick={run}>{deactivating ? 'Yes, deactivate' : 'Yes, activate'}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
