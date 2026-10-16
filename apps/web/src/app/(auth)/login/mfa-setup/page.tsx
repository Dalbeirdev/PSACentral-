import { ShieldPlus } from 'lucide-react';
import type { Metadata } from 'next';
import { MfaEnrollment } from '@/components/account/mfa-enrollment';
import { SignOutLink } from '../sign-out-link';
import { requireStep } from '../step-guard';

export const metadata: Metadata = { title: 'Set up two-step verification' };

export default async function MfaSetupPage() {
  await requireStep('mfa_setup_required');
  return (
    <>
      <span className="mb-5 flex size-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600 ring-1 ring-blue-100">
        <ShieldPlus className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Set up two-step verification</h1>
      <p className="mt-1.5 text-sm leading-6 text-slate-500">
        Multi-factor authentication is required for this environment. Register an authenticator app to finish signing in.
      </p>
      <div className="mt-6">
        <MfaEnrollment mode="required" />
      </div>
      <div className="mt-8 text-center">
        <SignOutLink />
      </div>
    </>
  );
}
