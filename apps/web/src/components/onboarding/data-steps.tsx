'use client';

import {
  clientStepSchema,
  deploymentStepSchema,
  type DuplicateCheckResponse,
  type OnboardingDraftData,
  psaConfigStepSchema,
  type PsaProviderDescriptor,
  type ServiceDto,
  servicesStepSchema,
  TARGET_ENVIRONMENTS,
  type UserRef,
} from '@psacc/contracts';
import { ArrowLeft, ArrowRight, Cloud, Container, FlaskConical, KeyRound, Monitor, Server, ServerCog, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  CompanyFields,
  type CompanyForm,
  ContactListFields,
  type ReferenceLists,
  type ContactForm,
  emptyCompany,
  emptyContact,
  emptyManagement,
  ManagementFields,
  type ManagementForm,
  toForm,
} from '@/components/clients/client-fields';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { apiQuery, zodErrors } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { prevStep, stepHref } from '@/lib/wizard';
import { PsaConfigFields } from '@/components/psa/psa-config-fields';
import { type ConfigValues, initialConfig } from '@/lib/psa-config';
import { ServiceConfigFields } from '@/components/services/service-config-fields';
import { configValuesForSubmit, groupByCategory, initialConfigValues } from '@/lib/services';
import { StepCard } from './wizard-frame';
import { useSaveStep } from './use-save-step';

export type ProviderOption = PsaProviderDescriptor;

interface StepProps {
  draftId: string;
  version: number;
}

function Footer({ draftId, step, busy, onExit }: { draftId: string; step: Parameters<typeof prevStep>[0]; busy: boolean; onExit?: () => void }) {
  const back = prevStep(step);
  return (
    <>
      {back ? (
        <ButtonLink href={stepHref(draftId, back)} variant="ghost">
          <ArrowLeft /> Back
        </ButtonLink>
      ) : (
        <ButtonLink href="/clients/new" variant="ghost">
          <ArrowLeft /> All drafts
        </ButtonLink>
      )}
      <div className="flex flex-wrap gap-2">
        {onExit ? (
          <Button type="button" variant="secondary" onClick={onExit} disabled={busy}>
            Save draft and exit
          </Button>
        ) : null}
        <Button type="submit" loading={busy}>
          Save and continue <ArrowRight />
        </Button>
      </div>
    </>
  );
}

function StepAlert({ error, stale }: { error: string | null; stale: boolean }) {
  if (!error) return null;
  return (
    <Alert
      variant="error"
      className="mb-6"
      actions={stale ? <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload</Button> : undefined}
    >
      {error}
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — client information
// ---------------------------------------------------------------------------
export function ClientStep({ draftId, version, initial, users, lists }: StepProps & { initial: OnboardingDraftData['client']; users: UserRef[]; lists: ReferenceLists }) {
  const [company, setCompany] = useState<CompanyForm>(() => toForm(emptyCompany(), initial?.company));
  const [management, setManagement] = useState<ManagementForm>(() => toForm(emptyManagement(), initial?.management));
  const [contacts, setContacts] = useState<ContactForm[]>(() =>
    initial?.contacts?.length ? initial.contacts.map((c) => toForm(emptyContact(), c)) : [emptyContact(['primary'])],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<DuplicateCheckResponse | null>(null);
  const [attempted, setAttempted] = useState(false);
  const { save, busy, error, serverErrors, stale, setError } = useSaveStep(draftId, version, 'client');

  // After the first submit attempt, fields re-validate as the user types (errors clear when fixed).
  useEffect(() => {
    if (!attempted) return;
    const r = clientStepSchema.safeParse({ company, management, contacts });
    setErrors(r.success ? {} : zodErrors(r.error.issues));
  }, [attempted, company, management, contacts]);

  // Live duplicate detection (debounced): reference availability + similarly named clients.
  useEffect(() => {
    const ref = company.clientReference.trim();
    const names = [company.legalName.trim(), company.displayName.trim()];
    if (!ref && names.every((n) => n.length < 3)) return setDup(null);
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ ...(ref ? { reference: ref } : {}), ...(names[0] ? { legalName: names[0] } : {}), ...(names[1] ? { displayName: names[1] } : {}) });
      const r = await apiQuery<DuplicateCheckResponse>(`/clients/duplicate-check?${qs}`, ctrl.signal);
      if (r.ok) setDup(r.data);
    }, 400);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [company.clientReference, company.legalName, company.displayName]);

  const payload = () => ({ company, management, contacts });
  const allErrors = { ...errors, ...serverErrors };
  if (dup?.referenceAvailable === false && !allErrors['company.clientReference']) allErrors['company.clientReference'] = 'This reference is already used by another client.';

  function validate(): unknown | null {
    setAttempted(true);
    const r = clientStepSchema.safeParse(payload());
    if (!r.success) {
      setErrors(zodErrors(r.error.issues));
      setError('Some fields need attention.');
      return null;
    }
    setErrors({});
    return r.data;
  }
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const data = validate();
    if (data) await save(data);
  };

  return (
    <form onSubmit={onSubmit} noValidate>
      <StepCard
        title="Client information"
        description="Company, location, management and contact details. Required fields are marked with *."
        footer={<Footer draftId={draftId} step="client" busy={busy} onExit={async () => { const d = validate(); if (d) await save(d, 'exit'); }} />}
      >
        <StepAlert error={error} stale={stale} />
        {dup?.similar.length ? (
          <Alert variant="warning" className="mb-6" title="Possible duplicate">
            Similar clients already exist:{' '}
            {dup.similar.map((s, i) => (
              <span key={s.id}>
                {i ? ', ' : ''}
                <Link href={`/clients/${s.id}`} target="_blank" className="font-medium underline">{s.displayName}</Link> ({s.code})
              </span>
            ))}
            . Continue only if this is a different company.
          </Alert>
        ) : null}
        <div className="space-y-6">
          <CompanyFields
            lists={lists}
            value={company}
            onChange={setCompany}
            errors={allErrors}
            referenceHint={dup?.referenceAvailable ? <span className="text-emerald-700">Available.</span> : undefined}
          />
          <ManagementFields value={management} onChange={setManagement} errors={allErrors} users={users} />
          <ContactListFields value={contacts} onChange={setContacts} errors={allErrors} />
        </div>
      </StepCard>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — PSA provider
// ---------------------------------------------------------------------------
export function ProviderStep({ draftId, version, initial, providers, configured }: StepProps & { initial: OnboardingDraftData['psa-provider']; providers: ProviderOption[]; configured: boolean }) {
  const [providerKey, setProviderKey] = useState<string>(initial?.providerKey ?? '');
  const { save, busy, error, serverErrors, stale, setError } = useSaveStep(draftId, version, 'psa-provider');
  const changing = configured && initial?.providerKey && providerKey !== initial.providerKey;
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (!providerKey) return setError('Choose a PSA provider.');
        await save({ providerKey });
      }}
    >
      <StepCard
        title="PSA provider"
        description="The professional services automation platform this client uses for tickets."
        footer={<Footer draftId={draftId} step="psa-provider" busy={busy} />}
      >
        <StepAlert error={error ?? serverErrors.providerKey ?? null} stale={stale} />
        {changing ? (
          <Alert variant="warning" className="mb-4">Changing the provider clears the PSA configuration saved in the next step.</Alert>
        ) : null}
        <fieldset>
          <legend className="sr-only">PSA provider</legend>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {providers.map((p) => {
              const on = providerKey === p.key;
              return (
                <label
                  key={p.key}
                  className={cn(
                    'relative flex cursor-pointer flex-col rounded-xl border p-4 transition-[border-color,box-shadow] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600',
                    on ? 'border-blue-500 bg-blue-50/50 shadow-[0_0_0_3px_rgb(37_99_235/0.12)]' : 'border-slate-200 bg-white hover:border-slate-300',
                  )}
                >
                  <input type="radio" name="provider" value={p.key} checked={on} onChange={() => setProviderKey(p.key)} className="sr-only" />
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">{p.name}</span>
                    <span className={cn('size-4 shrink-0 rounded-full border-2', on ? 'border-blue-600 bg-blue-600 shadow-[inset_0_0_0_2px_white]' : 'border-slate-300')} aria-hidden="true" />
                  </span>
                  <span className="mt-0.5 text-[12.5px] text-slate-500">{p.vendor}</span>
                  <span className="mt-3">
                    <Badge tone="neutral" className="h-5 px-1.5 text-[11px]">{p.adapterStatus === 'config_only' ? 'Configuration only · runs on the client appliance' : p.adapterStatus.replace('_', ' ')}</Badge>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <p className="mt-4 text-[13px] leading-5 text-slate-500">
          Selecting a provider records the configuration only. The PSA integration itself runs inside the client's Docker environment; a connection is marked verified only when that appliance reports a successful real test.
        </p>
      </StepCard>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — PSA configuration (no credentials)
// ---------------------------------------------------------------------------
export function PsaConfigStep({ draftId, version, initial, provider, clientName }: StepProps & { initial: OnboardingDraftData['psa-config']; provider: ProviderOption; clientName: string }) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? `${clientName} — ${provider.name}`);
  const [authMethod, setAuthMethod] = useState(initial?.authMethod ?? (provider.authMethods.length === 1 ? provider.authMethods[0]!.key : ''));
  const [config, setConfig] = useState<ConfigValues>(() => initialConfig(provider, initial?.config as Record<string, unknown> | undefined));
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { save, busy, error, serverErrors, stale, setError } = useSaveStep(draftId, version, 'psa-config');
  const all = { ...errors, ...serverErrors };
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = psaConfigStepSchema.safeParse({ displayName, authMethod, config, notes });
        if (!r.success) {
          setErrors(zodErrors(r.error.issues));
          return setError('Some fields need attention.');
        }
        setErrors({});
        await save(r.data);
      }}
    >
      <StepCard title={`${provider.name} configuration`} description="Non-secret settings for this client’s PSA instance. The provider adapter validates them and derives the API endpoint." footer={<Footer draftId={draftId} step="psa-config" busy={busy} />}>
        <StepAlert error={error} stale={stale} />
        <div className="space-y-6">
          <Field label="Instance name" required error={all.displayName}>
            {(p) => <Input {...p} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
          </Field>
          <PsaConfigFields descriptor={provider} authMethod={authMethod} onAuthMethod={setAuthMethod} config={config} onConfig={setConfig} errors={all} />
          <Field label="Notes" error={all.notes} hint="Anything to remember when configuring the integration. No secrets.">
            {(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          </Field>
        </div>
      </StepCard>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — services
// ---------------------------------------------------------------------------
export function ServicesStep({ draftId, version, initial, services }: StepProps & { initial: OnboardingDraftData['services']; services: ServiceDto[] }) {
  const [selected, setSelected] = useState<string[]>(() => initial?.serviceIds ?? services.filter((s) => s.isDefault).map((s) => s.id));
  const [config, setConfig] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(services.map((s) => [s.id, initialConfigValues(s.configRequirements, initial?.config?.[s.id])])),
  );
  const { save, busy, error, serverErrors, stale, setError } = useSaveStep(draftId, version, 'services');
  const groups = useMemo(() => groupByCategory(services), [services]);
  const setValue = (serviceId: string, key: string, value: string) => setConfig((c) => ({ ...c, [serviceId]: { ...(c[serviceId] ?? {}), [key]: value } }));
  const errorsFor = (serviceId: string) =>
    Object.fromEntries(Object.entries(serverErrors).filter(([k]) => k.startsWith(`config.${serviceId}.`)).map(([k, v]) => [k.slice(`config.${serviceId}.`.length), v]));
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const payload = {
          serviceIds: selected,
          config: Object.fromEntries(
            services.filter((s) => selected.includes(s.id) && s.configRequirements.length).map((s) => [s.id, configValuesForSubmit(s.configRequirements, config[s.id] ?? {})]),
          ),
        };
        const r = servicesStepSchema.safeParse(payload);
        if (!r.success) return setError(r.error.issues[0]!.message);
        await save(r.data);
      }}
    >
      <StepCard
        title="Services"
        description={`Select the services you provide to this client. ${selected.length} selected.`}
        footer={<Footer draftId={draftId} step="services" busy={busy} />}
      >
        <StepAlert error={error ?? serverErrors.serviceIds ?? null} stale={stale} />
        <div className="space-y-6">
          {groups.map((g) => (
            <fieldset key={g.name}>
              <legend className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">{g.name}</legend>
              <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                {g.items.map((s) => {
                  const on = selected.includes(s.id);
                  const errs = errorsFor(s.id);
                  return (
                    <div key={s.id} className={cn('rounded-xl border transition-colors', on ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 bg-white hover:border-slate-300', on && s.configRequirements.length ? 'sm:col-span-2' : '')}>
                      <label className="flex cursor-pointer items-start gap-3 p-3.5">
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 shrink-0 accent-blue-600"
                          checked={on}
                          onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-slate-900">{s.name}</span>
                            {s.isDefault ? <Badge tone="blue" className="h-5 px-1.5 text-[11px]">Default</Badge> : null}
                            {s.requiresPsa ? <Badge tone="violet" className="h-5 px-1.5 text-[11px]">Uses PSA</Badge> : null}
                            {s.configRequirements.some((r) => r.required) ? <Badge tone="amber" className="h-5 px-1.5 text-[11px]">Needs settings</Badge> : null}
                          </span>
                          <span className="mt-0.5 block text-xs leading-5 text-slate-500">{s.description}</span>
                        </span>
                      </label>
                      {on && s.configRequirements.length ? (
                        <div className="border-t border-blue-100 px-3.5 py-3" data-testid={`service-settings-${s.key}`}>
                          <p className="mb-3 text-[12.5px] font-medium text-slate-700">Settings for {s.name}</p>
                          <ServiceConfigFields requirements={s.configRequirements} values={config[s.id] ?? {}} onChange={(k, v) => setValue(s.id, k, v)} errors={errs} />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
        <p className="mt-6 text-[13px] text-slate-500">The catalog is managed under Service Catalog. The selection and these settings are included in the deployment configuration; credentials are never part of it.</p>
      </StepCard>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — deployment preferences
// ---------------------------------------------------------------------------
const ENV_ICON: Record<string, ReactNode> = {
  windows_docker: <Monitor />,
  linux_docker: <Container />,
  virtual_machine: <ServerCog />,
  client_server: <Server />,
  cloud_vm: <Cloud />,
  local_test: <FlaskConical />,
};

export function DeploymentStep({ draftId, version, initial }: StepProps & { initial: OnboardingDraftData['deployment'] }) {
  const [targetEnvironment, setEnv] = useState<string>(initial?.targetEnvironment ?? '');
  const [targetOs, setOs] = useState<string>(initial?.targetOs ?? '');
  const [targetArch, setArch] = useState<string>(initial?.targetArch ?? 'amd64');
  const [hostLabel, setHost] = useState(initial?.hostLabel ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { save, busy, error, serverErrors, stale, setError } = useSaveStep(draftId, version, 'deployment');
  const fixedOs = TARGET_ENVIRONMENTS.find((t) => t.key === targetEnvironment)?.os ?? null;
  const all = { ...errors, ...serverErrors };
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = deploymentStepSchema.safeParse({ targetEnvironment, targetOs, targetArch, hostLabel });
        if (!r.success) {
          setErrors(zodErrors(r.error.issues));
          return setError('Some fields need attention.');
        }
        setErrors({});
        await save(r.data);
      }}
    >
      <StepCard title="Deployment preferences" description="Where the client’s PSA Edge appliance will run." footer={<Footer draftId={draftId} step="deployment" busy={busy} />}>
        <StepAlert error={error} stale={stale} />
        <fieldset>
          <legend className="text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">Environment</legend>
          {all.targetEnvironment ? <p className="mt-1 text-xs font-medium text-red-700" role="alert">{all.targetEnvironment}</p> : null}
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {TARGET_ENVIRONMENTS.map((t) => {
              const on = targetEnvironment === t.key;
              return (
                <label
                  key={t.key}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600',
                    on ? 'border-blue-500 bg-blue-50/50' : 'border-slate-200 bg-white hover:border-slate-300',
                  )}
                >
                  <input
                    type="radio"
                    name="env"
                    className="sr-only"
                    checked={on}
                    onChange={() => {
                      setEnv(t.key);
                      if (t.os) setOs(t.os);
                    }}
                  />
                  <span className={cn('flex size-9 items-center justify-center rounded-lg [&_svg]:size-[18px]', on ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500')} aria-hidden="true">
                    {ENV_ICON[t.key]}
                  </span>
                  <span className="text-sm font-medium text-slate-800">{t.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field label="Host operating system" required error={all.targetOs} hint={fixedOs ? 'Set by the selected environment.' : undefined}>
            {(p) => (
              <Select {...p} value={targetOs} onChange={(e) => setOs(e.target.value)} disabled={!!fixedOs}>
                <option value="">Choose…</option>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </Select>
            )}
          </Field>
          <fieldset>
            <legend className="text-[13px] font-medium text-slate-700 after:ml-0.5 after:text-red-600 after:content-['*']">CPU architecture</legend>
            <div className="mt-2 flex gap-2">
              {(['amd64', 'arm64'] as const).map((a) => (
                <label key={a} className={cn('inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border px-4 font-mono text-sm', targetArch === a ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 text-slate-600')}>
                  <input type="radio" name="arch" className="accent-blue-600" checked={targetArch === a} onChange={() => setArch(a)} />
                  {a}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Host label" error={all.hostLabel} hint="Optional. A friendly name for the machine, e.g. srv-psa-01." className="sm:col-span-2">
            {(p) => <Input {...p} value={hostLabel} onChange={(e) => setHost(e.target.value)} />}
          </Field>
        </div>
        {targetEnvironment === 'windows_docker' ? (
          <Alert variant="info" className="mt-6">
            <span className="flex gap-2">
              <TriangleAlert className="mt-1 size-4 shrink-0" aria-hidden="true" />
              The appliance runs as Linux containers. On Windows, Docker Desktop or Docker Engine must use the WSL 2 (Linux containers) backend.
            </span>
          </Alert>
        ) : null}
      </StepCard>
    </form>
  );
}
