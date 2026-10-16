'use client';

import type { OnboardingDraftDto } from '@psacc/contracts';
import { ArrowLeft, CircleCheck, CircleDashed, Rocket } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/field';
import { apiMutate } from '@/lib/api-client';
import { stepHref } from '@/lib/wizard';
import { StepCard } from './wizard-frame';

/** Step 7: explicit inline confirmation, then atomic creation of all records. */
export function CreateStep({
  draftId,
  version,
  clientName,
  contactCount,
  serviceCount,
  providerName,
  missingPermissions,
}: {
  draftId: string;
  version: number;
  clientName: string;
  contactCount: number;
  serviceCount: number;
  providerName: string;
  missingPermissions: string[];
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const willCreate = [
    `Client record for ${clientName} with a new Client ID (CL-…)`,
    `${contactCount} contact${contactCount === 1 ? '' : 's'}`,
    `${providerName} PSA instance with a new PSA Instance ID (PSA-…) — connection status “Untested”`,
    `${serviceCount} service assignment${serviceCount === 1 ? '' : 's'}`,
    'License with a new License ID (LIC-…) for one deployment, covering the contract term from step 1',
    'Deployment record with a new Deployment ID (DEP-…) in the “Draft” lifecycle state',
  ];
  const later = [
    'Deployment package (Compose files, configuration, install and verify scripts, documentation) — generated in step 8',
    'Installation ID and single-use enrollment token — created with the package in step 8',
    'Agent machine certificate — issued when the installed agent enrolls',
  ];

  async function create() {
    setBusy(true);
    setError(null);
    const r = await apiMutate<OnboardingDraftDto>('POST', `/onboarding/drafts/${draftId}/complete`, { version, confirm: true });
    if (!r.ok) {
      setBusy(false);
      setError(r.problem.detail ?? 'The client could not be created.');
      return;
    }
    router.push(stepHref(draftId, 'download'));
  }

  return (
    <StepCard
      title="Create the client and deployment record"
      description="Everything below is created together in one transaction. If anything fails, nothing is created."
      footer={
        <>
          <ButtonLink href={stepHref(draftId, 'review')} variant="ghost">
            <ArrowLeft /> Back to review
          </ButtonLink>
          <Button onClick={create} loading={busy} disabled={!confirmed || missingPermissions.length > 0}>
            <Rocket /> Create client
          </Button>
        </>
      }
    >
      {error ? <Alert variant="error" className="mb-6">{error}</Alert> : null}
      {missingPermissions.length ? (
        <Alert variant="warning" className="mb-6" title="You can prepare this onboarding but not create it">
          Creating the client also creates its PSA instance and deployment record, which requires: {missingPermissions.join(', ')}. Ask an Operations Administrator to complete this step. The draft is saved.
        </Alert>
      ) : null}
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-labelledby="create-now">
          <h3 id="create-now" className="text-sm font-semibold text-slate-900">Created now</h3>
          <ul className="mt-3 space-y-2.5">
            {willCreate.map((w) => (
              <li key={w} className="flex gap-2.5 text-sm text-slate-700">
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
                {w}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="create-later">
          <h3 id="create-later" className="text-sm font-semibold text-slate-900">Not created yet</h3>
          <ul className="mt-3 space-y-2.5">
            {later.map((w) => (
              <li key={w} className="flex gap-2.5 text-sm text-slate-600">
                <CircleDashed className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />
                {w}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="mt-6 border-t border-slate-100 pt-6">
        <Checkbox
          label="I have reviewed the client, PSA, service and deployment details"
          description="After creation, details are edited from the client’s own pages."
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          disabled={missingPermissions.length > 0}
        />
      </div>
    </StepCard>
  );
}
