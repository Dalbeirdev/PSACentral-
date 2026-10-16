'use client';

import type { AuthStepResponse } from '@psacc/contracts';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, navigateTo } from '@/lib/api-client';

export function MfaVerifyForm() {
  const [mode, setMode] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    if (mode === 'totp' && !/^\d{6}$/.test(value)) return setError('Enter the 6-digit code.');
    if (mode === 'recovery' && value.replace(/[^a-z0-9]/gi, '').length !== 12) return setError('Recovery codes look like abcd-efgh-jkmn.');
    setBusy(true);
    setError(null);
    const r = await apiMutate<AuthStepResponse>('POST', '/auth/mfa/verify', { code: value });
    if (!r.ok) {
      setBusy(false);
      setCode('');
      if (r.status === 401) {
        navigateTo('/login?expired=1');
        return;
      }
      setError(r.problem.detail ?? 'Verification failed.');
      return;
    }
    navigateTo(r.data.redirectTo);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
      {error ? <Alert variant="error">{error}</Alert> : null}
      {mode === 'totp' ? (
        <Field label="Authentication code" error={undefined}>
          {(p) => (
            <Input
              {...p}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="h-12 text-center font-mono text-xl tracking-[0.5em]"
              placeholder="••••••"
            />
          )}
        </Field>
      ) : (
        <Field label="Recovery code" hint="Each recovery code works once.">
          {(p) => <Input {...p} name="code" autoComplete="off" autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="font-mono" placeholder="abcd-efgh-jkmn" />}
        </Field>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Verify and continue
      </Button>
      <button
        type="button"
        className="w-full text-center text-sm font-medium text-blue-700 hover:underline"
        onClick={() => {
          setMode((m) => (m === 'totp' ? 'recovery' : 'totp'));
          setCode('');
          setError(null);
        }}
      >
        {mode === 'totp' ? 'Use a recovery code instead' : 'Use authenticator app code'}
      </button>
    </form>
  );
}
