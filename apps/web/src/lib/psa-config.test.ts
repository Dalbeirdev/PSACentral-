import { configSchemaFor, PSA_PROVIDER_DESCRIPTORS } from '@psacc/contracts';
import { describe, expect, it } from 'vitest';
import { initialConfig } from './psa-config';

describe('initialConfig', () => {
  it('fills every descriptor field, applying defaults, so a new form starts complete', () => {
    const v = initialConfig(PSA_PROVIDER_DESCRIPTORS.servicenow);
    expect(Object.keys(v).sort()).toEqual(PSA_PROVIDER_DESCRIPTORS.servicenow.configFields.map((f) => f.key).sort());
    expect(v.incidentTable).toBe('incident');
    expect(v.instanceUrl).toBe('');
  });

  it('turns stored numbers into form strings and ignores keys the descriptor does not know', () => {
    const v = initialConfig(PSA_PROVIDER_DESCRIPTORS.autotask, { zone: 'webservices3', impersonationResourceId: 29682885, password: 'x' });
    expect(v.zone).toBe('webservices3');
    expect(v.impersonationResourceId).toBe('29682885');
    expect(v).not.toHaveProperty('password');
  });

  it('round-trips: stored config -> form values -> provider schema gives the same config back', () => {
    const samples: Record<string, Record<string, unknown>> = {
      autotask: { zone: 'webservices5', impersonationResourceId: 101 },
      connectwise: { site: 'onprem', onPremHost: 'psa.acme.example', companyId: 'acme' },
      halopsa: { tenantUrl: 'https://acme.halopsa.com', scope: 'all' },
      kaseya_bms: { region: 'bmsapac.kaseya.com', tenant: 'Acme Ltd' },
      freshservice: { domain: 'acme.freshservice.com' },
      servicenow: { instanceUrl: 'https://acme.service-now.com', incidentTable: 'incident' },
    };
    for (const [key, stored] of Object.entries(samples)) {
      const d = PSA_PROVIDER_DESCRIPTORS[key as keyof typeof PSA_PROVIDER_DESCRIPTORS];
      expect(configSchemaFor(d.key).parse(initialConfig(d, stored)), key).toEqual(configSchemaFor(d.key).parse(stored));
    }
  });
});
