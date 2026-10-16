'use client';

import type { OnboardingDraftDto } from '@psacc/contracts';
import { ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiMutate } from '@/lib/api-client';

export function StartOnboarding() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error ? <Alert variant="error" className="mb-3">{error}</Alert> : null}
      <Button
        size="lg"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const r = await apiMutate<OnboardingDraftDto>('POST', '/onboarding/drafts');
          if (!r.ok) {
            setBusy(false);
            setError(r.problem.detail ?? 'The onboarding could not be started.');
            return;
          }
          router.push(`/clients/new/${r.data.id}/client`);
        }}
      >
        Start onboarding <ArrowRight />
      </Button>
    </>
  );
}

/** Inline confirmation (no dialog) before abandoning a draft. */
export function AbandonDraft({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        Abandon…
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2 py-1 ring-1 ring-amber-200">
      <span className="text-[12.5px] text-amber-900">Abandon {name}?</span>
      <Button
        variant="danger"
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await apiMutate('POST', `/onboarding/drafts/${id}/abandon`);
          router.refresh();
        }}
      >
        Yes
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        No
      </Button>
    </span>
  );
}
