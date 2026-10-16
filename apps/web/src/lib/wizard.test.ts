import { describe, expect, it } from 'vitest';
import { formatCalendarDate, daysUntil } from './format';
import { availability, firstIncomplete, nextStep, prevStep, STEP_KEYS } from './wizard';

const draft = (completed: string[], status: 'in_progress' | 'completed' | 'abandoned' = 'in_progress') =>
  ({ status, completedSteps: completed }) as Parameters<typeof availability>[0];

describe('wizard step availability', () => {
  it('has the 10 steps in order', () => {
    expect(STEP_KEYS).toEqual(['client', 'psa-provider', 'psa-config', 'services', 'deployment', 'review', 'create', 'download', 'verify', 'complete']);
    expect(nextStep('deployment')).toBe('review');
    expect(prevStep('client')).toBeNull();
  });

  it('a new draft only opens step 1', () => {
    const d = draft([]);
    expect(availability(d, 'client', 'client')).toBe('current');
    expect(availability(d, 'psa-provider', 'client')).toBe('locked');
    expect(availability(d, 'review', 'client')).toBe('locked');
    expect(firstIncomplete(d)).toBe('client');
  });

  it('steps unlock in order and review/create need every section', () => {
    const d = draft(['client', 'psa-provider']);
    expect(availability(d, 'client', 'psa-config')).toBe('done');
    expect(availability(d, 'psa-config', 'psa-config')).toBe('current');
    expect(availability(d, 'services', 'psa-config')).toBe('locked');
    expect(availability(d, 'create', 'psa-config')).toBe('locked');
    expect(firstIncomplete(d)).toBe('psa-config');
    const all = draft(['client', 'psa-provider', 'psa-config', 'services', 'deployment']);
    expect(availability(all, 'create', 'review')).toBe('open');
    expect(availability(all, 'download', 'review')).toBe('locked');
  });

  it('after creation, steps 1–7 close and 8–10 open; abandoned drafts lock everything', () => {
    const done = draft(['client', 'psa-provider', 'psa-config', 'services', 'deployment'], 'completed');
    expect(availability(done, 'client', 'download')).toBe('done');
    expect(availability(done, 'create', 'download')).toBe('done');
    expect(availability(done, 'download', 'download')).toBe('current');
    expect(availability(done, 'complete', 'download')).toBe('open');
    expect(availability(draft([], 'abandoned'), 'client', 'client')).toBe('locked');
  });
});

describe('calendar dates', () => {
  it('render without time-zone shifting and count days', () => {
    expect(formatCalendarDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatCalendarDate(null)).toBe('—');
    expect(daysUntil('2026-10-24', new Date('2026-10-14T23:30:00Z'))).toBe(10);
  });
});
