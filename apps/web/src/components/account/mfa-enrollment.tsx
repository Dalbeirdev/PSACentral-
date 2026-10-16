'use client';

import type { MfaEnrollConfirmResponse, MfaEnrollStartResponse } from '@psacc/contracts';
import { Check, Copy, Smartphone } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { apiMutate, navigateTo } from '@/lib/api-client';

type Step = { kind: 'intro' } | { kind: 'scan'; data: MfaEnrollStartResponse } | { kind: 'codes'; data: MfaEnrollConfirmResponse };

/** Inline, multi-step TOTP enrollment. Recovery codes are shown exactly once. */
export function MfaEnrollment({ mode }: { mode: 'required' | 'settings' }) {
  const [step, setStep] = useState<Step>({ kind: 'intro' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    const r = await apiMutate<MfaEnrollStartResponse>('POST', '/auth/mfa/enroll/start');
    setBusy(false);
    if (!r.ok) return setError(r.problem.detail ?? 'Enrollment could not be started.');
    setStep({ kind: 'scan', data: r.data });
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code shown in your app.');
    setBusy(true);
    setError(null);
    const r = await apiMutate<MfaEnrollConfirmResponse>('POST', '/auth/mfa/enroll/confirm', { code });
    setBusy(false);
    setCode('');
    if (!r.ok) return setError(r.problem.detail ?? 'The code could not be verified.');
    setStep({ kind: 'codes', data: r.data });
  }

  if (step.kind === 'intro') {
    return (
      <div className="space-y-4">
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-600">
          <Smartphone className="mt-0.5 size-5 shrink-0 text-slate-400" aria-hidden="true" />
          <p className="leading-6">Use any TOTP authenticator, such as Microsoft Authenticator, Google Authenticator, 1Password or Bitwarden.</p>
        </div>
        <Button onClick={start} loading={busy} size={mode === 'required' ? 'lg' : 'md'} className={mode === 'required' ? 'w-full' : ''}>
          Set up authenticator app
        </Button>
      </div>
    );
  }

  if (step.kind === 'scan') {
    return (
      <form onSubmit={confirm} noValidate className="space-y-5">
        {error ? <Alert variant="error">{error}</Alert> : null}
        <ol className="space-y-5 text-sm text-slate-700">
          <li>
            <p className="font-medium text-slate-900">1. Scan this QR code with your authenticator app</p>
            <div
              className="mt-3 w-44 rounded-xl border border-slate-200 bg-white p-2 shadow-card [&_svg]:h-auto [&_svg]:w-full"
              aria-label="QR code for authenticator enrollment"
              role="img"
              // SVG generated server-side by the Control Plane API (qrcode library), not user input.
              dangerouslySetInnerHTML={{ __html: step.data.qrSvg }}
            />
            <details className="mt-3">
              <summary className="cursor-pointer text-[13px] font-medium text-blue-700">Can&apos;t scan? Enter the key manually</summary>
              <p className="mt-2 break-all rounded-lg bg-slate-50 px-3 py-2 font-mono text-[13px] tracking-wider text-slate-800 ring-1 ring-slate-200 select-all" data-testid="mfa-secret">
                {step.data.secret.match(/.{1,4}/g)?.join(' ')}
              </p>
            </details>
          </li>
          <li>
            <p className="font-medium text-slate-900">2. Enter the 6-digit code it shows</p>
            <Field label="Verification code" className="mt-3">
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="h-11 max-w-48 text-center font-mono text-lg tracking-[0.4em]"
                />
              )}
            </Field>
          </li>
        </ol>
        <Button type="submit" loading={busy}>
          Verify and enable
        </Button>
      </form>
    );
  }

  const codesText = step.data.recoveryCodes.join('\n');
  return (
    <div className="space-y-5">
      <Alert variant="success" title="Two-step verification is on">
        Save these recovery codes now. Each works once if you lose your device. They will not be shown again.
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-[13px] text-slate-800" data-testid="recovery-codes">
        {step.data.recoveryCodes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(codesText).catch(() => undefined);
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy codes'}
      </Button>
      <Checkbox label="I have stored my recovery codes somewhere safe" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
      <Button
        disabled={!saved}
        size={mode === 'required' ? 'lg' : 'md'}
        className={mode === 'required' ? 'w-full' : ''}
        onClick={() => {
          navigateTo(mode === 'required' ? step.data.redirectTo : '/settings/security?mfa=enabled');
        }}
      >
        Continue
      </Button>
    </div>
  );
}
