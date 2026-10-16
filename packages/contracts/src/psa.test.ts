import { describe, expect, it } from 'vitest';
import {
  buildConfigSchema,
  configSchemaFor,
  isFieldVisible,
  PSA_PROVIDER_CATALOG,
  PSA_PROVIDER_DESCRIPTORS,
  psaInstanceCreateSchema,
  type PsaProviderDescriptor,
} from './index.js';

describe('provider descriptors', () => {
  it('every provider has auth methods, config fields and unique keys', () => {
    for (const d of Object.values(PSA_PROVIDER_DESCRIPTORS)) {
      expect(d.authMethods.length, d.key).toBeGreaterThan(0);
      expect(new Set(d.configFields.map((f) => f.key)).size).toBe(d.configFields.length);
      for (const f of d.configFields) {
        if (f.type === 'select') expect(f.options?.length, `${d.key}.${f.key}`).toBeGreaterThan(0);
        if (f.showWhen) expect(d.configFields.some((x) => x.key === f.showWhen!.field)).toBe(true);
      }
      // A credential field never appears as a configuration field.
      const credKeys = d.authMethods.flatMap((m) => m.credentialFields.filter((c) => c.secret).map((c) => c.key));
      for (const k of credKeys) expect(d.configFields.some((f) => f.key === k), `${d.key} leaks ${k}`).toBe(false);
    }
  });

  it('the flat catalog is derived from the descriptors', () => {
    expect(PSA_PROVIDER_CATALOG.map((p) => p.key)).toEqual(Object.values(PSA_PROVIDER_DESCRIPTORS).sort((a, b) => a.sortOrder - b.sortOrder).map((d) => d.key));
    expect(PSA_PROVIDER_CATALOG.find((p) => p.key === 'servicenow')!.authMethods).toEqual(['oauth2_password', 'basic']);
  });
});

describe('buildConfigSchema', () => {
  const descriptor: PsaProviderDescriptor = {
    ...PSA_PROVIDER_DESCRIPTORS.custom_rest,
    configFields: [
      { key: 'mode', label: 'Mode', type: 'select', required: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'host', label: 'Host', type: 'host', required: true, showWhen: { field: 'mode', equals: 'b' } },
      { key: 'limit', label: 'Limit', type: 'number', min: 1, max: 10, default: 5 },
      { key: 'url', label: 'URL', type: 'url' },
      { key: 'name', label: 'Name', type: 'text', pattern: '^[a-z]+$', patternMessage: 'lowercase only' },
    ],
  };
  const schema = buildConfigSchema(descriptor);

  it('applies defaults, coerces numbers, drops blanks and hidden fields', () => {
    expect(schema.parse({ mode: 'a', host: 'ignored.example.com', limit: '', url: '' })).toEqual({ mode: 'a', limit: 5 });
    expect(schema.parse({ mode: 'b', host: 'PSA.Example.COM', limit: '7' })).toEqual({ mode: 'b', host: 'psa.example.com', limit: 7 });
  });

  it('enforces conditional required fields, ranges, patterns, https and unknown keys', () => {
    const issues = (v: object) => (schema.safeParse(v).error?.issues ?? []).map((i) => i.path.join('.') || i.code);
    expect(issues({ mode: 'b' })).toEqual(['host']);
    expect(issues({ mode: 'a', limit: 50 })).toEqual(['limit']);
    expect(issues({ mode: 'a', name: 'ABC' })).toEqual(['name']);
    expect(issues({ mode: 'a', url: 'http://x.example' })).toEqual(['url']);
    expect(issues({ mode: 'a', url: 'https://u:p@x.example' })).toEqual(['url']);
    expect(issues({ mode: 'a', password: 'x' })).toEqual(['unrecognized_keys']);
    expect(issues({})).toEqual(['mode']);
  });

  it('visibility follows showWhen', () => {
    const host = descriptor.configFields[1]!;
    expect(isFieldVisible(host, { mode: 'a' })).toBe(false);
    expect(isFieldVisible(host, { mode: 'b' })).toBe(true);
  });

  it('real provider schemas accept their documented examples', () => {
    expect(configSchemaFor('autotask').safeParse({ zone: 'webservices24' }).success).toBe(true);
    expect(configSchemaFor('autotask').safeParse({ zone: 'webservices25' }).success).toBe(false);
    expect(configSchemaFor('kaseya_bms').safeParse({ region: 'bmsapac.kaseya.com', tenant: 'Acme Ltd' }).success).toBe(true);
    expect(configSchemaFor('freshservice').safeParse({ domain: 'acme.freshservice.com', workspaceId: '2' }).success).toBe(true);
  });
});

describe('instance create schema', () => {
  it('requires a client and a known provider and defaults services to none', () => {
    const base = { clientId: '7d3b0c8e-4b69-4d0f-9a3f-6c0d5d2c1a11', providerKey: 'autotask', displayName: 'Acme — Autotask', authMethod: 'api_user', config: { zone: 'webservices1' } };
    expect(psaInstanceCreateSchema.parse(base).enabledServiceIds).toEqual([]);
    expect(psaInstanceCreateSchema.safeParse({ ...base, providerKey: 'jira' }).success).toBe(false);
    expect(psaInstanceCreateSchema.safeParse({ ...base, clientId: 'nope' }).success).toBe(false);
    expect(psaInstanceCreateSchema.safeParse({ ...base, apiKey: 'x' }).success).toBe(false); // strict: no credential fields at top level either
  });
});
