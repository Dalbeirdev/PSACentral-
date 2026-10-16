'use client';

import type { ClientServiceDto, PsaInstanceDetail, PsaProviderDescriptor } from '@psacc/contracts';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { ClientPicker, type ClientRef } from '@/components/clients/client-picker';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { apiMutate, apiQuery, fieldErrors } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { type ConfigValues, initialConfig } from '@/lib/psa-config';
import { PsaConfigFields } from './psa-config-fields';

interface ServiceOption {
  id: string;
  name: string;
  requiresPsa: boolean;
}

export function PsaInstanceForm({
  providers,
  instance,
  presetClient,
}: {
  providers: PsaProviderDescriptor[];
  instance?: PsaInstanceDetail;
  presetClient?: ClientRef | null;
}) {
  const router = useRouter();
  const editing = !!instance;
  const [client, setClient] = useState<ClientRef | null>(instance?.client ?? presetClient ?? null);
  const [providerKey, setProviderKey] = useState<string>(instance?.providerKey ?? '');
  const provider = providers.find((p) => p.key === providerKey) ?? null;
  const [displayName, setDisplayName] = useState(instance?.displayName ?? '');
  const [authMethod, setAuthMethod] = useState(instance?.authMethod ?? '');
  const [config, setConfig] = useState<ConfigValues>(() => (provider ? initialConfig(provider, instance?.config) : {}));
  const [notes, setNotes] = useState(instance?.notes ?? '');
  const [status, setStatus] = useState<'active' | 'disabled'>(instance?.status ?? 'active');
  const [services, setServices] = useState<ServiceOption[]>(() => instance?.availableServices ?? []);
  const [enabled, setEnabled] = useState<string[]>(() => instance?.enabledServices.map((s) => s.id) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  // Load the chosen client's services (create mode). Services that use a PSA are pre-selected.
  useEffect(() => {
    if (editing || !client) return;
    let cancelled = false;
    void (async () => {
      const r = await apiQuery<ClientServiceDto[]>(`/clients/${client.id}/services`);
      if (cancelled || !r.ok) return;
      setServices(r.data.map((s) => ({ id: s.id, name: s.name, requiresPsa: s.requiresPsa })));
      setEnabled(r.data.filter((s) => s.requiresPsa).map((s) => s.id));
    })();
    return () => {
      cancelled = true;
    };
  }, [client, editing]);

  function chooseProvider(key: string) {
    const p = providers.find((x) => x.key === key)!;
    setProviderKey(key);
    setConfig(initialConfig(p));
    setAuthMethod(p.authMethods.length === 1 ? p.authMethods[0]!.key : '');
    if (!displayName && client) setDisplayName(`${client.displayName} — ${p.name}`);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!client) local.clientId = 'Choose a client.';
    if (!providerKey) local.providerKey = 'Choose a PSA provider.';
    if (displayName.trim().length < 2) local.displayName = 'Enter a name for this PSA instance.';
    if (!authMethod) local.authMethod = 'Choose an authentication method.';
    if (Object.keys(local).length) {
      setErrors(local);
      return setError('Some fields need attention.');
    }
    setBusy(true);
    setError(null);
    const body = { displayName, authMethod, config, notes, enabledServiceIds: enabled };
    const r = editing
      ? await apiMutate<PsaInstanceDetail>('PATCH', `/psa-instances/${instance!.id}`, { ...body, version: instance!.version, status })
      : await apiMutate<PsaInstanceDetail>('POST', '/psa-instances', { ...body, clientId: client!.id, providerKey });
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setStale(r.problem.type === 'urn:psacc:problem:stale-version');
      return setError(r.problem.type === 'urn:psacc:problem:validation' ? 'Some fields need attention.' : (r.problem.detail ?? 'The PSA instance could not be saved.'));
    }
    router.push(`/psa/${r.data.id}?saved=${editing ? 'updated' : 'created'}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-8">
      {error ? (
        <Alert variant="error" actions={stale ? <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload latest</Button> : undefined}>
          {error}
        </Alert>
      ) : null}

      {!editing ? (
        <section className="space-y-6">
          <ClientPicker value={client} onChange={setClient} error={errors.clientId} />
          <fieldset>
            <legend className="text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">PSA provider</legend>
            {errors.providerKey ? <p className="mt-1 text-xs font-medium text-red-700" role="alert">{errors.providerKey}</p> : null}
            <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {providers.map((p) => (
                <label key={p.key} className={cn('flex cursor-pointer flex-col rounded-xl border p-3.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600', providerKey === p.key ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 hover:border-slate-300')}>
                  <input type="radio" name="provider" className="sr-only" checked={providerKey === p.key} onChange={() => chooseProvider(p.key)} />
                  <span className="text-sm font-semibold text-slate-900">{p.name}</span>
                  <span className="text-[12px] text-slate-500">{p.vendor}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </section>
      ) : null}

      {provider ? (
        <>
          <section className="space-y-6 border-t border-slate-100 pt-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Instance name" required error={errors.displayName}>
                {(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
              </Field>
              {editing ? (
                <Field label="Status" error={errors.status} hint={status === 'disabled' ? 'Disabled instances cannot be used by deployments.' : undefined}>
                  {(p) => (
                    <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}>
                      <option value="active">Active</option>
                      <option value="disabled">Disabled</option>
                    </Select>
                  )}
                </Field>
              ) : null}
            </div>
            <PsaConfigFields descriptor={provider} authMethod={authMethod} onAuthMethod={setAuthMethod} config={config} onConfig={setConfig} errors={errors} />
          </section>

          <fieldset className="border-t border-slate-100 pt-6">
            <legend className="text-sm font-semibold text-slate-900">Enabled services</legend>
            <p className="mt-0.5 text-[13px] text-slate-500">Which of the client’s services run through this PSA instance.</p>
            {errors.enabledServiceIds ? <p className="mt-2 text-xs font-medium text-red-700" role="alert">{errors.enabledServiceIds}</p> : null}
            {services.length ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {services.map((s) => (
                  <label key={s.id} className={cn('flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm', enabled.includes(s.id) ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200')}>
                    <input type="checkbox" className="size-4 accent-blue-600" checked={enabled.includes(s.id)} onChange={(e) => setEnabled((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))} />
                    <span className="font-medium text-slate-800">{s.name}</span>
                    {s.requiresPsa ? <Badge tone="violet" className="ml-auto h-5 px-1.5 text-[11px]">Uses PSA</Badge> : null}
                  </label>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-slate-500">{client ? 'This client has no services assigned yet.' : 'Choose a client first.'}</p>
            )}
          </fieldset>

          <Field label="Notes" error={errors.notes} hint="Anything to remember when configuring the integration. No secrets.">
            {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
        </>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-6">
        <ButtonLink href={editing ? `/psa/${instance!.id}` : '/psa'} variant="secondary"><ArrowLeft /> Cancel</ButtonLink>
        <Button type="submit" loading={busy}>{editing ? 'Save configuration' : 'Create PSA instance'}</Button>
      </div>
    </form>
  );
}
