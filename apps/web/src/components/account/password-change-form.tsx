'use client';

import type { AuthStepResponse } from '@psacc/contracts';
import { PASSWORD_MIN_LENGTH, passwordPolicyViolations } from '@psacc/contracts';
import { Check, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, navigateTo } from '@/lib/api-client';
import { cn } from '@/lib/cn';

export function PasswordChangeForm({ email, mode }: { email: string; mode: 'forced' | 'settings' }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const violations = next ? passwordPolicyViolations(next, email) : [];
  const mismatch = confirm.length > 0 && confirm !== next;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (!current || !next || violations.length || next !== confirm) {
      setError(next !== confirm ? 'The new passwords do not match.' : 'Complete all fields and meet the password requirements.');
      return;
    }
    setBusy(true);
    const r = await apiMutate<AuthStepResponse>('POST', '/auth/password', { currentPassword: current, newPassword: next });
    setBusy(false);
    if (!r.ok) {
      setError(r.problem.errors?.[0]?.message ?? r.problem.detail ?? 'The password could not be changed.');
      return;
    }
    setCurrent('');
    setNext('');
    setConfirm('');
    if (mode === 'forced' || r.data.state !== 'active') {
      navigateTo(r.data.redirectTo);
    } else {
      setSuccess(true);
    }
  }

  const rules = [
    { ok: next.length >= PASSWORD_MIN_LENGTH, label: `At least ${PASSWORD_MIN_LENGTH} characters` },
    { ok: next.length > 0 && !violations.some((v) => v.includes('email')), label: 'Does not contain your email name' },
    { ok: next.length > 0 && next !== current, label: 'Different from the current password' },
  ];

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {error ? <Alert variant="error">{error}</Alert> : null}
      {success ? <Alert variant="success" title="Password changed">Your other sessions were signed out.</Alert> : null}
      <Field label={mode === 'forced' ? 'Temporary password' : 'Current password'} required>
        {(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      </Field>
      <Field label="New password" required>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} invalid={p.invalid || (next.length > 0 && violations.length > 0)} />}
      </Field>
      <ul className="space-y-1.5 text-[12.5px]" aria-label="Password requirements">
        {rules.map((r) => (
          <li key={r.label} className={cn('flex items-center gap-2', r.ok ? 'text-emerald-700' : 'text-slate-500')}>
            {r.ok ? <Check className="size-3.5" aria-hidden="true" /> : <X className="size-3.5 text-slate-300" aria-hidden="true" />}
            {r.label}
            <span className="sr-only">{r.ok ? '(met)' : '(not met)'}</span>
          </li>
        ))}
      </ul>
      <Field label="Confirm new password" required error={mismatch ? 'Passwords do not match.' : undefined}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      <Button type="submit" size={mode === 'forced' ? 'lg' : 'md'} className={mode === 'forced' ? 'w-full' : ''} loading={busy}>
        {mode === 'forced' ? 'Save and continue' : 'Change password'}
      </Button>
    </form>
  );
}
