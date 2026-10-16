'use client';

import type { ClientServiceDto, PsaProviderDescriptor, ServiceDto } from '@psacc/contracts';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DefaultBadge, DependencyChip, IncompleteBadge, ServiceStatusBadge, UsesPsaBadge } from '@/components/services/badges';
import { ServiceConfigFields } from '@/components/services/service-config-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiMutate, fieldErrors } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { configValuesForSubmit, groupByCategory, initialConfigValues, unsupportedDependencies } from '@/lib/services';

/**
 * Assigns catalog services to a client and collects the settings each service requires.
 * Inactive services already assigned stay visible (and removable) but cannot be re-added.
 */
export function ServicesEditor({
  clientId,
  catalog,
  assigned,
  providers,
  canEdit,
}: {
  clientId: string;
  /** Active catalog services. */
  catalog: ServiceDto[];
  assigned: ClientServiceDto[];
  /** Adapter descriptors of the client's PSA providers, for dependency warnings. */
  providers: PsaProviderDescriptor[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const assignedIds = assigned.map((s) => s.id);
  // Everything selectable: the active catalog plus assigned services that have since been deactivated.
  const all = useMemo(() => {
    const extra = assigned.filter((a) => !catalog.some((c) => c.id === a.id));
    return [...catalog, ...extra].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [catalog, assigned]);
  const groups = useMemo(() => groupByCategory(all), [all]);
  const initialConfig = useMemo(
    () => Object.fromEntries(all.map((s) => [s.id, initialConfigValues(s.configRequirements, assigned.find((a) => a.id === s.id)?.config)])),
    [all, assigned],
  );
  const [selected, setSelected] = useState(assignedIds);
  const [config, setConfig] = useState<Record<string, Record<string, string>>>(initialConfig);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = [...selected].sort().join() !== [...assignedIds].sort().join() || JSON.stringify(config) !== JSON.stringify(initialConfig);

  const setValue = (serviceId: string, key: string, value: string) => setConfig((c) => ({ ...c, [serviceId]: { ...(c[serviceId] ?? {}), [key]: value } }));
  const errorsFor = (serviceId: string) =>
    Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(`config.${serviceId}.`)).map(([k, v]) => [k.slice(`config.${serviceId}.`.length), v]));

  async function save() {
    setBusy(true);
    setMessage(null);
    setErrors({});
    const body = {
      serviceIds: selected,
      config: Object.fromEntries(all.filter((s) => selected.includes(s.id) && s.configRequirements.length).map((s) => [s.id, configValuesForSubmit(s.configRequirements, config[s.id] ?? {})])),
    };
    const r = await apiMutate('PUT', `/clients/${clientId}/services`, body);
    setBusy(false);
    if (!r.ok) {
      setErrors(fieldErrors(r.problem));
      return setMessage({ ok: false, text: r.problem.type === 'urn:psacc:problem:validation' ? 'Some settings need attention.' : (r.problem.errors?.[0]?.message ?? r.problem.detail ?? 'Services could not be saved.') });
    }
    setMessage({ ok: true, text: 'Services saved and recorded in the activity history.' });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {message ? <Alert variant={message.ok ? 'success' : 'error'}>{message.text}</Alert> : null}
      {errors.serviceIds ? <Alert variant="error">{errors.serviceIds}</Alert> : null}
      {groups.map((g) => (
        <fieldset key={g.key} disabled={!canEdit}>
          <legend className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">{g.name}</legend>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map((s) => {
              const on = selected.includes(s.id);
              const current = assigned.find((a) => a.id === s.id);
              // A dependency is flagged only when none of the client's PSA providers supports it.
              const unsupportedByAll = on && providers.length ? unsupportedDependencies(s, providers[0]).filter((d) => providers.every((p) => unsupportedDependencies(s, p).some((u) => u.key === d.key))) : [];
              const expanded = on && s.configRequirements.length > 0;
              return (
                <div key={s.id} className={cn('rounded-xl border', on ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 bg-white', expanded ? 'sm:col-span-2 xl:col-span-3' : '')} data-testid={`service-${s.key}`}>
                  <label className={cn('flex items-start gap-3 p-3.5', canEdit && 'cursor-pointer')}>
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-blue-600"
                      checked={on}
                      disabled={!canEdit || (!s.isActive && !on)}
                      onChange={(e) => setSelected((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-slate-900">{s.name}</span>
                        {s.isDefault ? <DefaultBadge compact /> : null}
                        {s.requiresPsa ? <UsesPsaBadge compact /> : null}
                        {!s.isActive ? <ServiceStatusBadge active={false} /> : null}
                        {current && current.configIssues.length ? <IncompleteBadge compact /> : null}
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-slate-500">{s.description}</span>
                      {s.integrationDependencies.length ? (
                        <span className="mt-1.5 flex flex-wrap gap-1">
                          {s.integrationDependencies.map((d) => <DependencyChip key={d} dep={d} support={providers.length && on ? (unsupportedByAll.some((u) => u.key === d) ? 'unsupported' : undefined) : undefined} />)}
                        </span>
                      ) : null}
                      {on && unsupportedByAll.length ? (
                        <span className="mt-2 block rounded-lg bg-amber-50 px-2.5 py-1.5 text-[12.5px] text-amber-900 ring-1 ring-amber-200" role="status">
                          {unsupportedByAll.map((d) => d.label).join(', ')}: not supported by {providers.map((p) => p.name).join(' / ')} according to the adapter descriptor. The service can still be assigned; that capability will be unavailable.
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {expanded ? (
                    <div className="border-t border-blue-100 px-3.5 py-3">
                      <p className="mb-3 text-[12.5px] font-medium text-slate-700">Settings for {s.name}</p>
                      <ServiceConfigFields requirements={s.configRequirements} values={config[s.id] ?? {}} onChange={(k, v) => setValue(s.id, k, v)} errors={errorsFor(s.id)} disabled={!canEdit} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      {canEdit ? (
        <div className="flex items-center gap-3 border-t border-slate-100 pt-5">
          <Button onClick={save} loading={busy} disabled={!dirty}>Save services</Button>
          {dirty ? <span className="text-[13px] text-amber-700">Unsaved changes</span> : null}
        </div>
      ) : null}
    </div>
  );
}
