'use client';

import type { RemoteCommandDto } from '@psacc/contracts';
import { SendHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiMutate } from '@/lib/api-client';

/**
 * Asks the appliance to collect and deliver reports now by issuing a signed `refresh_health`
 * command (Module 13). The agent fetches it with its next heartbeat; the result is on the
 * Operations tab. Inline feedback only, no popup.
 */
export function ReportNowButton({ deploymentId }: { deploymentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function issue() {
    setBusy(true);
    const r = await apiMutate<RemoteCommandDto>('POST', `/deployments/${deploymentId}/commands`, { type: 'refresh_health', expiresInMinutes: 15 });
    setBusy(false);
    if (!r.ok) return setMessage({ ok: false, text: r.problem.detail ?? 'The request was not issued.' });
    setMessage({ ok: true, text: 'Asked the appliance to report now. It answers with its next heartbeat.' });
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" onClick={issue} loading={busy} data-testid="report-now"><SendHorizontal /> Ask the appliance to report now</Button>
      {message ? (
        <span role="status" className={`text-[12.5px] ${message.ok ? 'text-emerald-700' : 'text-red-700'}`}>
          {message.text} {message.ok ? <Link href={`/deployments/${deploymentId}/operations`} className="underline">Follow it on Operations</Link> : null}
        </span>
      ) : null}
    </span>
  );
}
