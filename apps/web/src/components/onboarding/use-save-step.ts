'use client';

import type { DataStepKey, OnboardingDraftDto } from '@psacc/contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiMutate, fieldErrors } from '@/lib/api-client';
import { nextStep, stepHref } from '@/lib/wizard';

/** Saves one wizard step on the server (with the draft version) and moves to the next step. */
export function useSaveStep(draftId: string, version: number, step: DataStepKey) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);

  async function save(data: unknown, then: 'next' | 'exit' = 'next') {
    setBusy(true);
    setError(null);
    setServerErrors({});
    const r = await apiMutate<OnboardingDraftDto>('PUT', `/onboarding/drafts/${draftId}/steps/${step}`, { version, data });
    if (!r.ok) {
      setBusy(false);
      setServerErrors(fieldErrors(r.problem));
      setStale(r.problem.type === 'urn:psacc:problem:stale-version');
      setError(r.problem.type === 'urn:psacc:problem:validation' ? 'Some fields need attention.' : (r.problem.detail ?? 'This step could not be saved.'));
      return false;
    }
    router.push(then === 'exit' ? '/clients/new' : stepHref(draftId, nextStep(step)));
    return true;
  }

  return { save, busy, error, serverErrors, stale, setError };
}
