import type { ConfigRequirement, PsaProviderDescriptor, ServiceDto } from '@psacc/contracts';
import { AUTOTASK, CUSTOM_REST, integrationDependency } from '@psacc/contracts';
import { describe, expect, it } from 'vitest';
import { configValuesForSubmit, dependencySupport, groupByCategory, initialConfigValues, requirementSummary, unsupportedDependencies } from './services';

const svc = (over: Partial<ServiceDto>): ServiceDto => ({
  id: 'id', key: 'k', name: 'N', description: '', category: { id: 'c', key: 'support', name: 'Support' }, isActive: true, isDefault: false, requiresPsa: false,
  integrationDependencies: [], configRequirements: [], sortOrder: 100, ...over,
});

describe('service helpers', () => {
  it('groups by category in catalog order', () => {
    const g = groupByCategory([svc({ id: '1' }), svc({ id: '2', category: { id: 'x', key: 'security', name: 'Security' } }), svc({ id: '3' })]);
    expect(g.map((x) => [x.key, x.items.length])).toEqual([['support', 2], ['security', 1]]);
  });

  it('derives dependency support from the provider adapter capabilities', () => {
    const tickets = integrationDependency('psa.tickets')!;
    const quotes = integrationDependency('psa.quotes')!;
    const rmm = integrationDependency('rmm')!;
    expect(dependencySupport(tickets, AUTOTASK as PsaProviderDescriptor)).toBe('supported');
    expect(dependencySupport(quotes, AUTOTASK as PsaProviderDescriptor)).toBe('not_modelled');
    expect(dependencySupport(rmm, AUTOTASK as PsaProviderDescriptor)).toBe('external');
    expect(dependencySupport(tickets, null)).toBe('not_modelled');
    const noAttachments = { ...CUSTOM_REST, capabilities: { ...CUSTOM_REST.capabilities, attachments: false } } as PsaProviderDescriptor;
    expect(unsupportedDependencies(svc({ integrationDependencies: ['psa.attachments', 'psa.tickets', 'rmm'] }), noAttachments).map((d) => d.key)).toEqual(['psa.attachments']);
  });

  it('round-trips configuration values through form strings', () => {
    const reqs: ConfigRequirement[] = [
      { key: 'days', label: 'Days', type: 'number', required: false },
      { key: 'on', label: 'On', type: 'boolean', required: false },
      { key: 'name', label: 'Name', type: 'text', required: true },
    ];
    const form = initialConfigValues(reqs, { days: 30, on: false });
    expect(form).toEqual({ days: '30', on: 'false', name: '' });
    expect(configValuesForSubmit(reqs, { ...form, name: 'x' })).toEqual({ days: 30, on: false, name: 'x' });
    expect(configValuesForSubmit(reqs, { days: '', on: '', name: '' })).toEqual({});
    expect(configValuesForSubmit(reqs, { days: 'abc', on: '', name: '' })).toEqual({ days: 'abc' }); // left to the contract to reject
  });

  it('summarizes a requirement for lists', () => {
    expect(requirementSummary({ key: 'd', label: 'D', type: 'number', required: true, min: 1, max: 10 })).toBe('Number · 1–10 · required');
    expect(requirementSummary({ key: 't', label: 'T', type: 'select', required: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })).toBe('Choice · A / B · optional');
  });
});
