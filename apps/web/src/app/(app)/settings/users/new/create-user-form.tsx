'use client';

import type { CreateUserResponse } from '@psacc/contracts';
import { createUserSchema } from '@psacc/contracts';
import { ArrowLeft, ArrowRight, Check, Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { apiMutate, fieldErrors } from '@/lib/api-client';

interface RoleOption {
  key: string;
  name: string;
  description: string;
  scope: 'all_clients' | 'assigned_clients';
}

export function CreateUserForm({ roles, canGrantPrivileged, defaultTimezone }: { roles: RoleOption[]; canGrantPrivileged: boolean; defaultTimezone: string }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreateUserResponse | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = createUserSchema.safeParse({ email, displayName, roleKeys, timezone: defaultTimezone });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path[0]?.toString() ?? '', i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    const r = await apiMutate<CreateUserResponse>('POST', '/users', parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setFormError(r.problem.detail ?? 'The user could not be created.');
      return;
    }
    setCreated(r.data);
  }

  if (created) {
    return (
      <div className="space-y-5">
        <Alert variant="success" title={`${created.user.displayName} was created`}>
          Roles: {created.user.roles.map((r) => r.name).join(', ')}. The account must set a new password at first sign-in.
        </Alert>
        {created.temporaryPassword ? (
          <div>
            <p className="text-sm font-medium text-slate-900">Temporary password</p>
            <p className="mt-0.5 text-[13px] text-slate-500">Share it through a secure channel. It is shown only once and cannot be retrieved later.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="select-all rounded-lg bg-slate-900 px-3 py-2 font-mono text-sm tracking-wide text-white" data-testid="temporary-password">
                {created.temporaryPassword}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(created.temporaryPassword!).catch(() => undefined);
                  setCopied(true);
                }}
              >
                {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-5">
          <ButtonLink href={`/settings/users/${created.user.id}`} variant="primary">
            Open user <ArrowRight />
          </ButtonLink>
          <ButtonLink href="/settings/users" variant="secondary">
            Back to users
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {formError ? <Alert variant="error">{formError}</Alert> : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Full name" error={errors.displayName} required>
          {(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />}
        </Field>
        <Field label="Email address" error={errors.email} required hint="Used to sign in. Must be unique.">
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
        </Field>
      </div>
      <fieldset>
        <legend className="text-[13px] font-medium text-slate-700">
          Roles <span className="text-red-600" aria-hidden="true">*</span>
        </legend>
        <p className="mt-0.5 text-xs text-slate-500">Permissions combine across roles. Technician access is limited to assigned clients.</p>
        {errors.roleKeys ? <p className="mt-1 text-xs font-medium text-red-700" role="alert">{errors.roleKeys}</p> : null}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {roles.map((r) => {
            const locked = r.key === 'super_admin' && !canGrantPrivileged;
            return (
              <Checkbox
                key={r.key}
                label={r.name}
                description={locked ? 'Requires permission to manage roles.' : `${r.description}${r.scope === 'assigned_clients' ? ' (assigned clients only)' : ''}`}
                checked={roleKeys.includes(r.key)}
                disabled={locked}
                onChange={(e) => setRoleKeys((cur) => (e.target.checked ? [...cur, r.key] : cur.filter((k) => k !== r.key)))}
              />
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-5">
        <ButtonLink href="/settings/users" variant="secondary">
          <ArrowLeft /> Back
        </ButtonLink>
        <Button type="submit" loading={busy}>
          Create user
        </Button>
      </div>
    </form>
  );
}
