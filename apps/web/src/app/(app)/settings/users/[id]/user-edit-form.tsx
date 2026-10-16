'use client';

import type { UserDetail } from '@psacc/contracts';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { apiMutate, navigateTo } from '@/lib/api-client';

interface RoleOption {
  key: string;
  name: string;
  description: string;
  scope: 'all_clients' | 'assigned_clients';
}

export function UserEditForm({
  user,
  roles,
  canManage,
  canGrantPrivileged,
  saved,
}: {
  user: { id: string; displayName: string; status: 'active' | 'disabled'; roleKeys: string[] };
  roles: RoleOption[];
  canManage: boolean;
  canGrantPrivileged: boolean;
  saved: boolean;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [roleKeys, setRoleKeys] = useState(user.roleKeys);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const r = await apiMutate<UserDetail>('PATCH', `/users/${user.id}`, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.problem.errors?.[0]?.message ?? r.problem.detail ?? 'Changes could not be saved.');
      return false;
    }
    navigateTo(`/settings/users/${user.id}?saved=1`);
    return true;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!roleKeys.length) return setError('Assign at least one role.');
    const body: Record<string, unknown> = {};
    if (displayName !== user.displayName) body.displayName = displayName;
    if ([...roleKeys].sort().join() !== [...user.roleKeys].sort().join()) body.roleKeys = roleKeys;
    if (!Object.keys(body).length) return setError('Nothing has changed.');
    await patch(body);
  }

  const disabled = !canManage;
  return (
    <div className="space-y-6">
      {saved ? <Alert variant="success">Changes saved and recorded in the audit log.</Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      <form onSubmit={onSubmit} noValidate className="space-y-6">
        <Field label="Display name">
          {(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={disabled} />}
        </Field>
        <fieldset disabled={disabled}>
          <legend className="text-[13px] font-medium text-slate-700">Roles</legend>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <Checkbox
                key={r.key}
                label={r.name}
                description={r.description || undefined}
                checked={roleKeys.includes(r.key)}
                disabled={disabled || (r.key === 'super_admin' && !canGrantPrivileged)}
                onChange={(e) => setRoleKeys((cur) => (e.target.checked ? [...cur, r.key] : cur.filter((k) => k !== r.key)))}
              />
            ))}
          </div>
        </fieldset>
        {canManage ? (
          <Button type="submit" loading={busy}>
            Save changes
          </Button>
        ) : null}
      </form>

      {canManage ? (
        <section className="border-t border-slate-100 pt-6" aria-labelledby="status-heading">
          <h3 id="status-heading" className="text-sm font-semibold text-slate-900">
            {user.status === 'active' ? 'Disable access' : 'Re-enable access'}
          </h3>
          <p className="mt-1 text-[13px] leading-5 text-slate-500">
            {user.status === 'active'
              ? 'Disabling signs the user out everywhere and blocks sign-in. History and audit records are kept.'
              : 'The user will be able to sign in again with their existing credentials.'}
          </p>
          {!confirmStatus ? (
            <Button variant={user.status === 'active' ? 'secondary' : 'subtle'} className="mt-3" onClick={() => setConfirmStatus(true)}>
              {user.status === 'active' ? 'Disable user…' : 'Enable user…'}
            </Button>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
              <p className="mr-2 text-[13px] font-medium text-amber-900">Confirm: {user.status === 'active' ? 'disable' : 'enable'} {user.displayName}?</p>
              <Button variant={user.status === 'active' ? 'danger' : 'primary'} size="sm" loading={busy} onClick={() => patch({ status: user.status === 'active' ? 'disabled' : 'active' })}>
                Yes, {user.status === 'active' ? 'disable' : 'enable'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmStatus(false)}>
                Cancel
              </Button>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
