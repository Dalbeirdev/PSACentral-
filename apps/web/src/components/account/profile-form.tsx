'use client';

import { profileUpdateSchema } from '@psacc/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { apiMutate, fieldErrors } from '@/lib/api-client';

export function ProfileForm({ displayName, timezone, timezones }: { displayName: string; timezone: string; timezones: string[] }) {
  const router = useRouter();
  // Provided by the server so server-rendered and hydrated markup match (ICU data differs by runtime).
  const zones = timezones.includes(timezone) ? timezones : [timezone, ...timezones];
  const [name, setName] = useState(displayName);
  const [tz, setTz] = useState(timezone);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = profileUpdateSchema.safeParse({ displayName: name, timezone: tz });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    const r = await apiMutate('PATCH', '/auth/profile', parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setStatus('error');
      setMessage(r.problem.detail ?? 'Profile could not be saved.');
      return;
    }
    setStatus('saved');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {status === 'saved' ? <Alert variant="success">Profile saved. Times now display in {tz}.</Alert> : null}
      {status === 'error' ? <Alert variant="error">{message}</Alert> : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Display name" error={errors.displayName} required>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
        </Field>
        <Field label="Preferred time zone" hint="Used for every timestamp and chart in the dashboard." error={errors.timezone} required>
          {(p) => (
            <Select {...p} value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Button type="submit" loading={busy}>
        Save profile
      </Button>
    </form>
  );
}
