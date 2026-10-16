import { describe, expect, it } from 'vitest';
import {
  clientCompanySchema,
  clientStepSchema,
  contactListSchema,
  DEFAULT_SERVICES,
  deploymentStepSchema,
  psaConfigStepSchema,
  PSA_PROVIDER_CATALOG,
  STEP_SCHEMAS,
  DATA_STEPS,
} from './index.js';

const company = {
  legalName: 'Acme Holdings Ltd', displayName: 'Acme', clientReference: 'ACME-01', businessType: 'Technology',
  countryCode: 'GB', stateRegion: '', city: 'London', timezone: 'Europe/London', website: '',
};
const contact = (email: string, roles: string[]) => ({ fullName: 'Sam Example', email, roles, jobTitle: '', phone: '', mobile: '', notes: '' });

describe('client schemas', () => {
  it('normalizes optional blanks to undefined and validates references, countries, time zones and websites', () => {
    const ok = clientCompanySchema.parse(company);
    expect(ok.website).toBeUndefined();
    expect(ok.stateRegion).toBeUndefined();
    expect(clientCompanySchema.safeParse({ ...company, countryCode: 'UK' }).success).toBe(false);
    expect(clientCompanySchema.safeParse({ ...company, timezone: 'Europe/Atlantis' }).success).toBe(false);
    expect(clientCompanySchema.safeParse({ ...company, website: 'javascript:alert(1)' }).success).toBe(false);
    expect(clientCompanySchema.safeParse({ ...company, website: 'https://acme.example' }).success).toBe(true);
    expect(clientCompanySchema.safeParse({ ...company, clientReference: 'ref<script>' }).success).toBe(false);
    expect(clientCompanySchema.safeParse({ ...company, businessType: 'Pirates' }).success).toBe(false);
  });

  it('requires exactly one primary contact and unique emails', () => {
    expect(contactListSchema.safeParse([contact('a@x.example', ['primary']), contact('b@x.example', ['technical'])]).success).toBe(true);
    expect(contactListSchema.safeParse([contact('a@x.example', ['technical'])]).success).toBe(false);
    expect(contactListSchema.safeParse([contact('a@x.example', ['primary']), contact('b@x.example', ['primary'])]).success).toBe(false);
    const dup = contactListSchema.safeParse([contact('a@x.example', ['primary']), contact('A@X.example', ['billing'])]);
    expect(dup.success).toBe(false);
    expect(dup.error!.issues[0]!.path).toEqual([1, 'email']);
    expect(contactListSchema.safeParse([]).success).toBe(false);
  });

  it('rejects contract end before start and phone numbers that are not numbers', () => {
    const step = { company, management: { contractStartDate: '2026-05-01', contractEndDate: '2026-04-30' }, contacts: [contact('a@x.example', ['primary'])] };
    const r = clientStepSchema.safeParse(step);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain('management.contractEndDate');
    expect(clientStepSchema.safeParse({ ...step, management: {}, contacts: [{ ...contact('a@x.example', ['primary']), phone: 'call me maybe' }] }).success).toBe(false);
    expect(clientStepSchema.safeParse({ ...step, management: {}, contacts: [{ ...contact('a@x.example', ['primary']), phone: '+44 20 7946 0000 ext. 12' }] }).success).toBe(true);
  });

  it('uses friendly messages for missing fields', () => {
    const r = clientCompanySchema.safeParse({});
    expect(r.success).toBe(false);
    expect(r.error!.issues.find((i) => i.path[0] === 'displayName')!.message).toBe('This field is required.');
  });
});

describe('onboarding step schemas', () => {
  it('has a schema for every data step', () => {
    expect(Object.keys(STEP_SCHEMAS).sort()).toEqual([...DATA_STEPS].sort());
  });

  it('PSA step carries provider config only; the endpoint is derived by the adapter, credentials are never accepted', () => {
    expect(psaConfigStepSchema.parse({ displayName: 'PSA', authMethod: 'api_user' }).config).toEqual({});
    expect(psaConfigStepSchema.safeParse({ displayName: 'PSA', authMethod: 'api_user', config: { zone: 'webservices1' } }).success).toBe(true);
    expect(psaConfigStepSchema.safeParse({ displayName: 'PSA', authMethod: 'api_user', apiEndpoint: 'https://psa.example/api' }).success).toBe(false);
    expect(psaConfigStepSchema.safeParse({ displayName: 'PSA', authMethod: 'api_user', password: 'x' }).success).toBe(false);
  });

  it('deployment OS must match fixed-OS environments', () => {
    expect(deploymentStepSchema.safeParse({ targetEnvironment: 'windows_docker', targetOs: 'linux', targetArch: 'amd64' }).success).toBe(false);
    expect(deploymentStepSchema.safeParse({ targetEnvironment: 'windows_docker', targetOs: 'windows', targetArch: 'amd64' }).success).toBe(true);
    expect(deploymentStepSchema.safeParse({ targetEnvironment: 'cloud_vm', targetOs: 'windows', targetArch: 'arm64', hostLabel: '' }).success).toBe(true);
    expect(deploymentStepSchema.safeParse({ targetEnvironment: 'cloud_vm', targetOs: 'linux', targetArch: 'x86' }).success).toBe(false);
  });

  it('default catalog: Help Desk is the only default; the 7 required PSA providers are present', () => {
    expect(DEFAULT_SERVICES.filter((s) => s.isDefault).map((s) => s.key)).toEqual(['help_desk']);
    expect(DEFAULT_SERVICES).toHaveLength(18);
    expect(PSA_PROVIDER_CATALOG.map((p) => p.key)).toEqual(['autotask', 'connectwise', 'halopsa', 'kaseya_bms', 'freshservice', 'servicenow', 'custom_rest']);
  });
});
