import { describe, expect, it } from 'vitest';
import { formatDateTime, greeting, initials, percent, relativeTime, safeNextPath } from './format';
import { HEALTH_COLORS, HEALTH_LABELS, HEALTH_ORDER } from './health';
import { ALL_NAV_ITEMS, DELIVERED_MODULES, PLANNED, sectionFor } from './nav';
import { hrefWith, pickParams } from './query';

describe('safeNextPath (open-redirect guard)', () => {
  it.each([
    ['/audit?outcome=failure', '/audit?outcome=failure'],
    ['/settings/users', '/settings/users'],
    ['//evil.example', null],
    ['/\\evil.example', null],
    ['https://evil.example', null],
    ['javascript:alert(1)', null],
    ['/login?next=/x', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (input, expected) => {
    expect(safeNextPath(input as string | undefined)).toBe(expected);
  });
});

describe('formatting', () => {
  it('formats timestamps in the requested time zone', () => {
    const iso = '2026-10-14T12:00:00Z';
    expect(formatDateTime(iso, 'UTC')).toContain('12:00');
    expect(formatDateTime(iso, 'Asia/Tokyo')).toContain('21:00');
    expect(formatDateTime(null, 'UTC')).toBe('—');
  });

  it('produces relative times, greetings, initials and percentages', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(relativeTime('2026-10-14T11:58:00Z', now)).toBe('2 minutes ago');
    expect(relativeTime(null)).toBe('never');
    expect(greeting('UTC', new Date('2026-10-14T09:00:00Z'))).toBe('Good morning');
    expect(greeting('UTC', new Date('2026-10-14T20:00:00Z'))).toBe('Good evening');
    expect(initials('Avery  Vance')).toBe('AV');
    expect(percent(15, 20)).toBe('75%');
    expect(percent(1, 0)).toBe('0%');
  });
});

describe('query helpers', () => {
  it('merges params and drops empty values', () => {
    expect(hrefWith('/audit', { q: 'x', page: '3' }, { page: undefined, sort: 'action:asc' })).toBe('/audit?q=x&sort=action%3Aasc');
    expect(hrefWith('/audit', {}, {})).toBe('/audit');
  });

  it('keeps only known string params of bounded length', () => {
    expect(pickParams({ q: 'a', evil: 'x', page: ['1', '2'], sort: 'x'.repeat(500) }, ['q', 'page', 'sort'])).toEqual({ q: 'a' });
  });
});

describe('navigation & health constants', () => {
  it('has the 12 required sidebar entries, each planned one described', () => {
    expect(ALL_NAV_ITEMS.map((i) => i.label)).toEqual([
      'Overview', 'Clients', 'PSA Management', 'Service Catalog', 'Deployments', 'Docker Images', 'Database Explorer',
      'Health Monitoring', 'Integrations', 'Licenses', 'Activity & Audit Logs', 'Settings',
    ]);
    for (const item of ALL_NAV_ITEMS.filter((i) => !DELIVERED_MODULES.has(i.module))) {
      expect(PLANNED[item.href.slice(1)]?.module).toBe(item.module);
    }
    expect(sectionFor('/settings/users/abc')).toBe('Settings');
  });

  it('defines a color and label for every health state', () => {
    for (const s of HEALTH_ORDER) {
      expect(HEALTH_COLORS[s]).toMatch(/^#[0-9A-F]{6}$/i);
      expect(HEALTH_LABELS[s]).toBeTruthy();
    }
  });
});

describe('formatBytes', () => {
  it('formats package sizes', async () => {
    const { formatBytes } = await import('./deployments');
    expect([formatBytes(512), formatBytes(16_480), formatBytes(3 * 1024 * 1024)]).toEqual(['512 B', '16.1 KB', '3.0 MB']);
  });
});
