'use client';

import type { ServiceCategoryDto, ServiceDetail } from '@psacc/contracts';
import { INTEGRATION_DEPENDENCIES, integrationDependency, serviceCreateSchema, serviceUpdateSchema, suggestServiceKey } from '@psacc/contracts';
import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { apiMutate, fieldErrors, zodErrors } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { draftFromRequirement, type RequirementDraft, RequirementsEditor, requirementsFromDrafts } from './requirements-editor';

/** Full-page create / edit form for a catalog service. Validation is inline; the key is immutable once created. */
export function ServiceForm({ categories, service }: { categories: ServiceCategoryDto[]; service?: ServiceDetail }) {
  const router = useRouter();
  const editing = !!service;
  const [name, setName] = useState(service?.name ?? '');
  const [key, setKey] = useState(service?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(editing);
  const [description, setDescription] = useState(service?.description ?? '');
  const [categoryId, setCategoryId] = useState(service?.category.id ?? categories[0]?.id ?? '');
  const [isDefault, setIsDefault] = useState(service?.isDefault ?? false);
  const [requiresPsa, setRequiresPsa] = useState(service?.requiresPsa ?? false);
  const [deps, setDeps] = useState<string[]>(service?.integrationDependencies ?? []);
  const [sortOrder, setSortOrder] = useState(String(service?.sortOrder ?? 100));
  const [drafts, setDrafts] = useState<RequirementDraft[]>(() => service?.configRequirements.map(draftFromRequirement) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);

  function toggleDep(k: string, on: boolean) {
    setDeps((c) => (on ? [...c, k] : c.filter((x) => x !== k)));
    // PSA data dependencies run through the client's PSA; switch the flag on so the form stays consistent.
    if (on && integrationDependency(k)?.kind === 'psa') setRequiresPsa(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      name, description, categoryId, isDefault, requiresPsa, integrationDependencies: deps, configRequirements: requirementsFromDrafts(drafts),
      sortOrder: sortOrder.trim() === '' ? 100 : Number(sortOrder),
    };
    const parsed = editing ? serviceUpdateSchema.safeParse({ ...body, version: service!.version }) : serviceCreateSchema.safeParse({ ...body, key });
    if (!parsed.success) {
      setErrors(zodErrors(parsed.error.issues));
      return setError('Some fields need attention.');
    }
    setBusy(true);
    const r = editing
      ? await apiMutate<ServiceDetail>('PATCH', `/services/${service!.id}`, parsed.data)
      : await apiMutate<ServiceDetail>('POST', '/services', parsed.data);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      setStale(r.problem.type === 'urn:psacc:problem:stale-version');
      return setError(r.problem.type === 'urn:psacc:problem:validation' ? 'Some fields need attention.' : (r.problem.detail ?? 'The service could not be saved.'));
    }
    router.push(`/services/${r.data.id}?saved=${editing ? 'updated' : 'created'}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-8">
      {error ? (
        <Alert variant="error" actions={stale ? <Button type="button" variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload latest</Button> : undefined}>
          {error}
        </Alert>
      ) : null}

      <section className="grid gap-5 sm:grid-cols-2">
        <Field label="Service name" required error={errors.name}>
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(suggestServiceKey(e.target.value));
              }}
            />
          )}
        </Field>
        <Field label="Key" required error={errors.key} hint={editing ? 'Fixed once created: appliances store configuration by key.' : 'Lowercase letters, digits and underscores. Used in deployment packages and audit history.'}>
          {(p) => (
            <Input
              {...p}
              value={key}
              readOnly={editing}
              className="font-mono"
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Category" required error={errors.categoryId}>
          {(p) => (
            <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.length ? null : <option value="">No categories yet</option>}
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Sort order" error={errors.sortOrder} hint="Lower numbers come first within the category.">
          {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={10000} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />}
        </Field>
        <Field label="Description" error={errors.description} className="sm:col-span-2" hint="Shown wherever the service is chosen (onboarding, client services).">
          {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
      </section>

      <section className="grid gap-3 border-t border-slate-100 pt-6 sm:grid-cols-2">
        <Checkbox label="Default service" description="Pre-selected for every new client in the onboarding wizard. Defaults must stay active." checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        {errors.isDefault ? <p className="text-xs font-medium text-red-700 sm:col-span-2" role="alert">{errors.isDefault}</p> : null}
        <Checkbox label="Uses the client’s PSA" description="The service runs through the client’s PSA instance (tickets, assets, projects…). Enabled per PSA instance." checked={requiresPsa} onChange={(e) => setRequiresPsa(e.target.checked)} />
        {errors.requiresPsa ? <p className="text-xs font-medium text-red-700 sm:col-span-2" role="alert">{errors.requiresPsa}</p> : null}
      </section>

      <fieldset className="border-t border-slate-100 pt-6">
        <legend className="text-sm font-semibold text-slate-900">Integration dependencies</legend>
        <p className="mt-0.5 text-[13px] text-slate-500">What the service needs from the client’s PSA or other platforms. PSA dependencies are checked against each client’s provider adapter.</p>
        {errors.integrationDependencies ? <p className="mt-2 text-xs font-medium text-red-700" role="alert">{errors.integrationDependencies}</p> : null}
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {INTEGRATION_DEPENDENCIES.map((d) => {
            const on = deps.includes(d.key);
            return (
              <label key={d.key} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm', on ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200')}>
                <input type="checkbox" className="mt-0.5 size-4 accent-blue-600" checked={on} onChange={(e) => toggleDep(d.key, e.target.checked)} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-slate-900">{d.label}</span>
                    <Badge tone={d.kind === 'psa' ? 'violet' : 'cyan'} className="h-5 px-1.5 text-[11px]">{d.kind === 'psa' ? 'PSA data' : 'External platform'}</Badge>
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500">{d.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <section className="border-t border-slate-100 pt-6">
        <h2 className="text-sm font-semibold text-slate-900">Configuration requirements</h2>
        <p className="mt-0.5 mb-4 text-[13px] text-slate-500">Settings a client must supply when the service is assigned. Non-secret values only: credentials are entered on the client’s appliance and never pass through the Control Plane.</p>
        <RequirementsEditor drafts={drafts} onChange={setDrafts} errors={errors} />
      </section>

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-6">
        <ButtonLink href={editing ? `/services/${service!.id}` : '/services'} variant="secondary"><ArrowLeft /> Cancel</ButtonLink>
        <Button type="submit" loading={busy}>{editing ? 'Save service' : 'Create service'}</Button>
      </div>
    </form>
  );
}
