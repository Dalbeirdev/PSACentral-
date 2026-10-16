import type { ConfigRequirement, IntegrationDependencyDefinition, PsaProviderDescriptor, ServiceDto } from '@psacc/contracts';
import { INTEGRATION_DEPENDENCIES, integrationDependency } from '@psacc/contracts';

/** Groups catalog services by category, keeping the catalog's order. */
export function groupByCategory<T extends ServiceDto>(services: T[]): { key: string; name: string; items: T[] }[] {
  const m = new Map<string, { key: string; name: string; items: T[] }>();
  for (const s of services) {
    const g = m.get(s.category.key) ?? { key: s.category.key, name: s.category.name, items: [] };
    g.items.push(s);
    m.set(s.category.key, g);
  }
  return [...m.values()];
}

export type DependencySupport = 'supported' | 'unsupported' | 'not_modelled' | 'external';

/**
 * Whether a PSA provider can serve an integration dependency, from the adapter descriptor's capabilities.
 * `external` = not a PSA dependency; `not_modelled` = PSA data the adapter framework does not describe yet (Module 12).
 */
export function dependencySupport(dep: IntegrationDependencyDefinition, provider: PsaProviderDescriptor | null | undefined): DependencySupport {
  if (dep.kind !== 'psa') return 'external';
  if (!dep.capability) return 'not_modelled';
  if (!provider) return 'not_modelled';
  return provider.capabilities[dep.capability] ? 'supported' : 'unsupported';
}

/** Dependencies of a service that the given provider is known not to support. */
export function unsupportedDependencies(service: Pick<ServiceDto, 'integrationDependencies'>, provider: PsaProviderDescriptor | null | undefined): IntegrationDependencyDefinition[] {
  return service.integrationDependencies
    .map((k) => integrationDependency(k))
    .filter((d): d is IntegrationDependencyDefinition => !!d && dependencySupport(d, provider) === 'unsupported');
}

export const DEPENDENCY_OPTIONS = INTEGRATION_DEPENDENCIES.map((d) => ({ key: d.key, label: d.label, kind: d.kind, description: d.description }));

/** Human summary of a requirement's constraints for lists and hints. */
export function requirementSummary(r: ConfigRequirement): string {
  const parts: string[] = [];
  parts.push({ text: 'Text', number: 'Number', boolean: 'Yes / no', select: 'Choice', url: 'URL' }[r.type]);
  if (r.type === 'number' && (r.min !== undefined || r.max !== undefined)) parts.push(`${r.min ?? '…'}–${r.max ?? '…'}`);
  if (r.type === 'select' && r.options) parts.push(r.options.map((o) => o.label).join(' / '));
  parts.push(r.required ? 'required' : 'optional');
  return parts.join(' · ');
}

/** Initial form values for a service's requirements from stored values (strings for inputs). */
export function initialConfigValues(requirements: ConfigRequirement[], stored: Record<string, string | number | boolean> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of requirements) {
    const v = stored?.[r.key];
    out[r.key] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** Converts form strings back to typed values; empty strings are omitted (the contract drops them for optional settings). */
export function configValuesForSubmit(requirements: ConfigRequirement[], values: Record<string, string>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const r of requirements) {
    const v = values[r.key];
    if (v === undefined || v.trim() === '') continue;
    if (r.type === 'number') {
      const n = Number(v);
      out[r.key] = Number.isFinite(n) ? n : v;
    } else if (r.type === 'boolean') out[r.key] = v === 'true';
    else out[r.key] = v;
  }
  return out;
}
