'use client';

import type { AuthStepResponse } from '@psacc/contracts';
import { loginRequestSchema } from '@psacc/contracts';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, fieldErrors, navigateTo } from '@/lib/api-client';

export function LoginForm({ next }: { next: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = loginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    const r = await apiMutate<AuthStepResponse>('POST', '/auth/login', parsed.data);
    if (!r.ok) {
      setBusy(false);
      setErrors(fieldErrors(r.problem));
      setFormError(r.status === 429 ? 'Too many sign-in attempts. Wait a minute and try again.' : (r.problem.detail ?? 'Sign-in failed.'));
      setPassword('');
      return;
    }
    navigateTo(r.data.state === 'active' && next ? next : r.data.redirectTo);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5" aria-describedby={formError ? 'login-error' : undefined}>
      {formError ? (
        <div id="login-error">
          <Alert variant="error">{formError}</Alert>
        </div>
      ) : null}
      <Field label="Email address" error={errors.email} required>
        {(p) => (
          <Input {...p} type="email" name="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
        )}
      </Field>
      <Field label="Password" error={errors.password} required>
        {(p) => (
          <div className="relative">
            <Input
              {...p}
              type={show ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-1.5 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        )}
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
        {!busy ? <ArrowRight /> : null}
      </Button>
      <p className="text-center text-xs leading-5 text-slate-500">
        Accounts are created by an administrator. Repeated failed attempts temporarily lock the account.
      </p>
    </form>
  );
}
