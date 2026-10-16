import { PSA_PROVIDER_CATALOG, PSA_PROVIDER_KEYS } from '@psacc/contracts';
import { describe, expect, it } from 'vitest';
import { PsaAdapterRegistry, psaAdapterProviders } from '../../src/modules/psa/adapters/registry.js';

const registry = new PsaAdapterRegistry(psaAdapterProviders[0]!.useFactory());
const parse = (key: string, auth: string, config: Record<string, unknown>) => registry.get(key).parseConfig(config, auth);

describe('PSA adapter registry', () => {
  it('has exactly one adapter per catalog provider', () => {
    expect(registry.all().map((a) => a.key)).toEqual([...PSA_PROVIDER_KEYS]);
    expect(PSA_PROVIDER_CATALOG.map((p) => p.key)).toEqual([...PSA_PROVIDER_KEYS]);
  });

  it('rejects unknown providers and duplicate registrations', () => {
    expect(() => registry.get('jira')).toThrow(/No adapter/);
    const dup = psaAdapterProviders[0]!.useFactory();
    expect(() => new PsaAdapterRegistry([...dup, dup[0]!])).toThrow(/Duplicate/);
  });

  it('control-plane adapters are configuration-only: no connection method and no network access', () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls++; throw new Error('the control plane must not call a PSA API'); }) as typeof fetch;
    try {
      for (const a of registry.all()) {
        expect(a.descriptor.adapterStatus).toBe('config_only');
        expect('testConnection' in a, a.key).toBe(false);
        a.parseConfig({}, a.descriptor.authMethods[0]!.key);
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('endpoint derivation', () => {
  it.each([
    ['autotask', 'api_user', { zone: 'webservices5' }, 'https://webservices5.autotask.net/ATServicesRest'],
    ['autotask', 'api_user', { zone: 'custom', customZoneUrl: 'https://webservices99.autotask.net/' }, 'https://webservices99.autotask.net/ATServicesRest'],
    ['connectwise', 'api_member_keys', { site: 'eu', companyId: 'acme' }, 'https://api-eu.myconnectwise.net/v4_6_release/apis/3.0'],
    ['connectwise', 'api_member_keys', { site: 'onprem', onPremHost: 'PSA.Acme.com', companyId: 'acme' }, 'https://psa.acme.com/v4_6_release/apis/3.0'],
    ['halopsa', 'oauth2_client_credentials', { tenantUrl: 'https://acme.halopsa.com/' }, 'https://acme.halopsa.com/api'],
    ['kaseya_bms', 'username_password', { region: 'bmsemea.kaseya.com', tenant: 'acme' }, 'https://bmsemea.kaseya.com/api'],
    ['freshservice', 'api_key', { domain: 'acme.freshservice.com' }, 'https://acme.freshservice.com/api/v2'],
    ['servicenow', 'basic', { instanceUrl: 'https://acme.service-now.com' }, 'https://acme.service-now.com/api/now'],
    ['custom_rest', 'api_key', { baseUrl: 'https://psa.acme.com/api/' }, 'https://psa.acme.com/api'],
  ])('%s → %s', (key, auth, config, endpoint) => {
    const r = parse(key, auth, config);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.endpoint).toBe(endpoint);
  });

  it('applies defaults and drops fields hidden by conditions', () => {
    const r = parse('connectwise', 'api_member_keys', { site: 'na', onPremHost: 'ignored.example.com', companyId: 'acme' });
    expect(r.ok && r.config).toEqual({ site: 'na', companyId: 'acme' });
    const s = parse('servicenow', 'basic', { instanceUrl: 'https://acme.service-now.com' });
    expect(s.ok && s.config.incidentTable).toBe('incident');
  });
});

describe('configuration validation', () => {
  it.each([
    ['autotask', 'api_user', {}, 'config.zone'],
    ['autotask', 'api_user', { zone: 'custom' }, 'config.customZoneUrl'],
    ['autotask', 'api_user', { zone: 'custom', customZoneUrl: 'https://evil.example.com' }, 'config.customZoneUrl'],
    ['autotask', 'api_user', { zone: 'webservices1', defaultQueueId: 'abc' }, 'config.defaultQueueId'],
    ['connectwise', 'api_member_keys', { site: 'mars', companyId: 'acme' }, 'config.site'],
    ['connectwise', 'api_member_keys', { site: 'onprem', companyId: 'acme' }, 'config.onPremHost'],
    ['connectwise', 'api_member_keys', { site: 'na', companyId: 'bad id!' }, 'config.companyId'],
    ['halopsa', 'oauth2_client_credentials', { tenantUrl: 'http://acme.halopsa.com' }, 'config.tenantUrl'],
    ['halopsa', 'oauth2_client_credentials', { tenantUrl: 'https://acme.halopsa.com/some/path' }, 'config.tenantUrl'],
    ['freshservice', 'api_key', { domain: 'https://acme.freshservice.com' }, 'config.domain'],
    ['servicenow', 'basic', { instanceUrl: 'https://user:pw@acme.service-now.com' }, 'config.instanceUrl'],
    ['custom_rest', 'oauth2_client_credentials', { baseUrl: 'https://psa.acme.com' }, 'config.tokenUrl'],
    ['custom_rest', 'api_key', { baseUrl: 'https://psa.acme.com', ticketsPath: 'tickets' }, 'config.ticketsPath'],
  ])('%s %s %o → error at %s', (key, auth, config, path) => {
    const r = parse(key, auth, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(path);
  });

  it('rejects an authentication method the provider does not support', () => {
    const r = parse('autotask', 'oauth2', { zone: 'webservices1' });
    expect(!r.ok && r.issues.map((i) => i.path)).toContain('authMethod');
  });

  it('never accepts credential fields inside configuration', () => {
    for (const [key, auth, base, secretKey] of [
      ['autotask', 'api_user', { zone: 'webservices1' }, 'secret'],
      ['connectwise', 'api_member_keys', { site: 'na', companyId: 'x1' }, 'privateKey'],
      ['halopsa', 'oauth2_client_credentials', { tenantUrl: 'https://a.halopsa.com' }, 'clientSecret'],
      ['freshservice', 'api_key', { domain: 'a.freshservice.com' }, 'apiKey'],
      ['servicenow', 'basic', { instanceUrl: 'https://a.service-now.com' }, 'password'],
    ] as const) {
      const r = parse(key, auth, { ...base, [secretKey]: 'hunter2' });
      expect(r.ok, `${key} must reject ${secretKey}`).toBe(false);
      if (!r.ok) expect(r.issues[0]!.message).toMatch(/Credentials are never stored/);
    }
  });
});
