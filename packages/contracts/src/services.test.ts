import { describe, expect, it } from 'vitest';
import {
  checkServiceConfig,
  clientServicesUpdateSchema,
  configRequirementSchema,
  DEFAULT_SERVICES,
  INTEGRATION_DEPENDENCIES,
  integrationDependency,
  serviceCategoryCreateSchema,
  serviceCreateSchema,
  serviceListQuerySchema,
  serviceUpdateSchema,
  suggestServiceKey,
} from './services.js';
import { servicesStepSchema } from './onboarding.js';

const CAT = '0b6a4f5e-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const SVC = '1c7b5a6f-3d4e-4f60-9b0c-1d2e3f4a5b6c';

describe('service catalog contracts', () => {
  it('default services only reference dependencies from the fixed vocabulary, and defaults stay consistent', () => {
    for (const s of DEFAULT_SERVICES) {
      for (const d of s.integrationDependencies) expect(integrationDependency(d), `${s.key} → ${d}`).toBeDefined();
      if (s.integrationDependencies.some((d) => integrationDependency(d)!.kind === 'psa')) expect(s.requiresPsa, `${s.key} depends on PSA data`).toBe(true);
      for (const r of s.configRequirements ?? []) expect(configRequirementSchema.safeParse(r).success, `${s.key}.${r.key}`).toBe(true);
    }
    expect(DEFAULT_SERVICES.filter((s) => s.isDefault).map((s) => s.key)).toEqual(['help_desk']);
    expect(new Set(INTEGRATION_DEPENDENCIES.map((d) => d.key)).size).toBe(INTEGRATION_DEPENDENCIES.length);
  });

  it('configuration requirements refuse secrets, demand options for selects and keep ranges for numbers only', () => {
    const base = { key: 'tenantDomain', label: 'Tenant domain', type: 'text' as const, required: true };
    expect(configRequirementSchema.safeParse(base).success).toBe(true);
    const secret = configRequirementSchema.safeParse({ ...base, key: 'apiKey', label: 'API key' });
    expect(secret.success).toBe(false);
    expect(secret.success ? '' : secret.error.issues[0]!.message).toMatch(/appliance|secrets/);
    expect(configRequirementSchema.safeParse({ ...base, label: 'Service account password' }).success).toBe(false);
    expect(configRequirementSchema.safeParse({ ...base, key: 'Tenant_domain' }).success).toBe(false);
    expect(configRequirementSchema.safeParse({ ...base, type: 'select' }).success).toBe(false);
    expect(configRequirementSchema.safeParse({ ...base, type: 'select', options: [{ value: 'a', label: 'A' }] }).success).toBe(false);
    expect(configRequirementSchema.safeParse({ ...base, type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }).success).toBe(false);
    expect(configRequirementSchema.safeParse({ ...base, type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }).success).toBe(true);
    expect(configRequirementSchema.safeParse({ ...base, min: 1 }).success).toBe(false);
    expect(configRequirementSchema.safeParse({ ...base, type: 'number', min: 10, max: 1 }).success).toBe(false);
    expect(configRequirementSchema.safeParse({ ...base, type: 'number', min: 1, max: 10 }).success).toBe(true);
  });

  it('checkServiceConfig normalizes values, reports missing required settings and unknown keys', () => {
    const reqs = [
      { key: 'tenantDomain', label: 'Tenant domain', type: 'text' as const, required: true },
      { key: 'retentionDays', label: 'Retention', type: 'number' as const, required: false, min: 1, max: 365 },
      { key: 'portal', label: 'Portal', type: 'url' as const, required: false },
      { key: 'notify', label: 'Notify', type: 'boolean' as const, required: false },
      { key: 'tier', label: 'Tier', type: 'select' as const, required: true, options: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] },
    ];
    const ok = checkServiceConfig(reqs, { tenantDomain: ' contoso.onmicrosoft.com ', retentionDays: '30', portal: 'https://portal.example', notify: 'true', tier: 'gold' });
    expect(ok.issues).toEqual([]);
    expect(ok.config).toEqual({ tenantDomain: 'contoso.onmicrosoft.com', retentionDays: 30, portal: 'https://portal.example', notify: true, tier: 'gold' });

    const bad = checkServiceConfig(reqs, { retentionDays: 900, portal: 'ftp://x', notify: 'maybe', tier: 'bronze', extra: 1 });
    expect(bad.issues.map((i) => i.path).sort()).toEqual(['extra', 'notify', 'portal', 'retentionDays', 'tenantDomain', 'tier']);
    expect(bad.issues.find((i) => i.path === 'tenantDomain')!.message).toBe('Tenant domain is required.');

    // Optional settings left empty are dropped, not stored as empty strings.
    const empty = checkServiceConfig(reqs, { tenantDomain: 'x', tier: 'silver', retentionDays: '', portal: '' });
    expect(empty.issues).toEqual([]);
    expect(empty.config).toEqual({ tenantDomain: 'x', tier: 'silver' });
    expect(checkServiceConfig([], null).issues).toEqual([]);
  });

  it('service create/update schemas: key format, PSA consistency, immutable key on update', () => {
    const good = serviceCreateSchema.safeParse({ key: 'dark_web_monitoring', name: 'Dark Web Monitoring', categoryId: CAT, requiresPsa: true, integrationDependencies: ['psa.tickets'] });
    expect(good.success).toBe(true);
    expect(good.success && good.data.configRequirements).toEqual([]);
    expect(serviceCreateSchema.safeParse({ key: 'Dark-Web', name: 'Dark Web', categoryId: CAT }).success).toBe(false);
    const inconsistent = serviceCreateSchema.safeParse({ key: 'x_y', name: 'X Y', categoryId: CAT, requiresPsa: false, integrationDependencies: ['psa.tickets'] });
    expect(inconsistent.success).toBe(false);
    expect(inconsistent.success ? '' : inconsistent.error.issues[0]!.path.join('.')).toBe('requiresPsa');
    expect(serviceCreateSchema.safeParse({ key: 'x_y', name: 'X Y', categoryId: CAT, integrationDependencies: ['jira'] }).success).toBe(false);
    expect(serviceCreateSchema.safeParse({ key: 'x_y', name: 'X Y', categoryId: CAT, integrationDependencies: ['rmm', 'rmm'] }).success).toBe(false);
    expect(serviceUpdateSchema.safeParse({ version: '1', key: 'new_key', name: 'X Y', categoryId: CAT }).success).toBe(false); // unrecognized key
    expect(serviceUpdateSchema.safeParse({ version: '1', name: 'X Y', categoryId: CAT, sortOrder: '50' }).success).toBe(true);
    expect(serviceCategoryCreateSchema.safeParse({ key: 'compliance', name: 'Compliance' }).success).toBe(true);
    expect(serviceCategoryCreateSchema.safeParse({ key: 'c', name: 'Compliance' }).success).toBe(false);
    expect(serviceListQuerySchema.safeParse({ status: 'active', dependency: 'rmm', usesPsa: '1' }).success).toBe(true);
    expect(serviceListQuerySchema.safeParse({ status: 'archived' }).success).toBe(false);
  });

  it('client assignment and the wizard step carry per-service settings keyed by service id', () => {
    const r = clientServicesUpdateSchema.safeParse({ serviceIds: [SVC], config: { [SVC]: { tenantDomain: 'x', retentionDays: 30, notify: true } } });
    expect(r.success).toBe(true);
    expect(clientServicesUpdateSchema.safeParse({ serviceIds: [SVC] }).success && clientServicesUpdateSchema.parse({ serviceIds: [SVC] }).config).toEqual({});
    expect(clientServicesUpdateSchema.safeParse({ serviceIds: [SVC], config: { notAnId: {} } }).success).toBe(false);
    expect(clientServicesUpdateSchema.safeParse({ serviceIds: [SVC], config: { [SVC]: { nested: { a: 1 } } } }).success).toBe(false);
    expect(servicesStepSchema.parse({ serviceIds: [SVC] }).config).toEqual({});
    expect(servicesStepSchema.safeParse({ serviceIds: [], config: {} }).success).toBe(false);
  });

  it('suggests catalog keys from names', () => {
    expect(suggestServiceKey('Dark Web Monitoring')).toBe('dark_web_monitoring');
    expect(suggestServiceKey('  Microsoft 365 — Backup!  ')).toBe('microsoft_365_backup');
    expect(suggestServiceKey('24x7 SOC')).toBe('x7_soc');
    expect(suggestServiceKey('#')).toBe('');
  });
});
