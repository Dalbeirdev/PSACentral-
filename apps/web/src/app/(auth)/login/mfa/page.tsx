import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { SignOutLink } from '../sign-out-link';
import { requireStep } from '../step-guard';
import { MfaVerifyForm } from './mfa-verify-form';

export const metadata: Metadata = { title: 'Verify sign-in' };

export default async function MfaPage() {
  const me = await requireStep('mfa_pending');
  return (
    <>
      <span className="mb-5 flex size-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600 ring-1 ring-blue-100">
        <ShieldCheck className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Two-step verification</h1>
      <p className="mt-1.5 text-sm leading-6 text-slate-500">
        Enter the 6-digit code from the authenticator app registered to <span className="font-medium text-slate-700">{me.user.email}</span>.
      </p>
      <MfaVerifyForm />
      <div className="mt-8 text-center">
        <SignOutLink />
      </div>
    </>
  );
}
