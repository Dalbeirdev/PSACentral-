'use client';

import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, navigateTo } from '@/lib/api-client';

/** Inline confirmation section (no dialog) to turn off MFA when policy allows it. */
export function MfaDisable() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Turn off two-step verification
      </Button>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await apiMutate('POST', '/auth/mfa/disable', { password, code });
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'MFA could not be disabled.');
    navigateTo('/settings/security?mfa=disabled');
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4 rounded-xl border border-red-200 bg-red-50/40 p-4">
      <p className="text-sm font-semibold text-red-800">Confirm turning off two-step verification</p>
      <p className="text-[13px] leading-5 text-slate-600">Your account will be protected by your password only, and your recovery codes will stop working.</p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Password" required>
          {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <Field label="Current 6-digit code" required>
          {(p) => <Input {...p} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="font-mono" />}
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" loading={busy}>
          Turn off
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
