'use client';

import { DEFAULT_HEALTH_POLICY, type HealthPolicy, healthPolicySchema } from '@psacc/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { apiMutate, fieldErrors, zodErrors } from '@/lib/api-client';

const FIELDS: { key: keyof HealthPolicy; label: string; hint: string; unit: string }[] = [
  { key: 'heartbeatIntervalSeconds', label: 'Heartbeat interval', hint: 'Agents receive this on every heartbeat and adapt.', unit: 's' },
  { key: 'offlineAfterSeconds', label: 'Offline after', hint: 'At least two heartbeat intervals without a heartbeat.', unit: 's' },
  { key: 'staleReportAfterSeconds', label: 'Reports stale after', hint: 'A database report older than this degrades the deployment.', unit: 's' },
  { key: 'cpuWarnPercent', label: 'CPU warning', hint: '', unit: '%' },
  { key: 'cpuCriticalPercent', label: 'CPU critical', hint: '', unit: '%' },
  { key: 'memoryWarnPercent', label: 'Memory warning', hint: '', unit: '%' },
  { key: 'memoryCriticalPercent', label: 'Memory critical', hint: '', unit: '%' },
  { key: 'diskWarnPercent', label: 'Disk warning', hint: '', unit: '%' },
  { key: 'diskCriticalPercent', label: 'Disk critical', hint: '', unit: '%' },
  { key: 'backupMaxAgeHours', label: 'Backup maximum age', hint: 'An older last backup degrades the deployment.', unit: 'h' },
  { key: 'certificateWarnDays', label: 'Certificate warning', hint: 'Days before expiry at which a deployment is degraded.', unit: 'days' },
];

export function HealthPolicyForm({ initial }: { initial: HealthPolicy }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<keyof HealthPolicy, string>>(Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, String(v)])) as Record<keyof HealthPolicy, string>);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ variant: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const candidate = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]));
    const parsed = healthPolicySchema.safeParse(candidate);
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      setNotice({ variant: 'error', text: 'Some thresholds need attention.' });
      return;
    }
    setBusy(true);
    const r = await apiMutate<HealthPolicy>('PUT', '/monitoring/policy', parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setNotice({ variant: 'error', text: r.problem.detail ?? 'The policy was not saved.' });
      return;
    }
    setErrors({});
    setNotice({ variant: 'success', text: 'Health policy saved. Every live deployment has been re-evaluated with the new thresholds.' });
    router.refresh();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      {notice ? <Alert variant={notice.variant}>{notice.text}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <Field key={f.key} label={`${f.label} (${f.unit})`} hint={f.hint || undefined} error={errors[f.key]} required>
            {(p) => <Input {...p} type="number" inputMode="decimal" value={values[f.key]} onChange={(e) => { setValues({ ...values, [f.key]: e.target.value }); setErrors((x) => ({ ...x, [f.key]: '' })); }} />}
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>Save policy</Button>
        <Button type="button" variant="ghost" onClick={() => { setValues(Object.fromEntries(Object.entries(DEFAULT_HEALTH_POLICY).map(([k, v]) => [k, String(v)])) as Record<keyof HealthPolicy, string>); setErrors({}); }}>Reset to defaults</Button>
      </div>
    </form>
  );
}
