import { KeyRound } from 'lucide-react';
import type { Metadata } from 'next';
import { PasswordChangeForm } from '@/components/account/password-change-form';
import { SignOutLink } from '../sign-out-link';
import { requireStep } from '../step-guard';

export const metadata: Metadata = { title: 'Set a new password' };

export default async function ForcedPasswordPage() {
  const me = await requireStep('password_change_required');
  return (
    <>
      <span className="mb-5 flex size-11 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-amber-100">
        <KeyRound className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Choose a new password</h1>
      <p className="mt-1.5 text-sm leading-6 text-slate-500">
        Your account was created with a temporary password. Replace it before continuing.
      </p>
      <div className="mt-6">
        <PasswordChangeForm email={me.user.email} mode="forced" />
      </div>
      <div className="mt-8 text-center">
        <SignOutLink />
      </div>
    </>
  );
}
