import { describe, expect, it } from 'vitest';
import { formatBytesLong, formatEstimate, parseTableRef, tableRef, tableStatus } from './database';

describe('database explorer helpers', () => {
  it('round-trips schema.table references and rejects malformed ones', () => {
    expect(parseTableRef(tableRef('public', 'helpdesk_tickets'))).toEqual({ schema: 'public', name: 'helpdesk_tickets' });
    expect(parseTableRef('audit.events.v2')).toEqual({ schema: 'audit', name: 'events.v2' });
    expect(parseTableRef('nodot')).toBeNull();
    expect(parseTableRef('.name')).toBeNull();
    expect(parseTableRef('schema.')).toBeNull();
    expect(parseTableRef(`${'a'.repeat(70)}.${'b'.repeat(70)}`)).toBeNull();
  });

  it('never presents an estimate as an exact count', () => {
    expect(formatEstimate(null)).toBe('not analysed');
    expect(formatEstimate(1234567)).toBe('≈ 1,234,567');
    expect(formatEstimate(0)).toBe('≈ 0');
  });

  it('derives a table status from what was actually reported', () => {
    expect(tableStatus({ estimatedRows: 5, detailsObservedAt: null })).toEqual({ label: 'Details pending', tone: 'amber' });
    expect(tableStatus({ estimatedRows: null, detailsObservedAt: '2026-10-14T00:00:00Z' })).toEqual({ label: 'Never analysed', tone: 'neutral' });
    expect(tableStatus({ estimatedRows: 0, detailsObservedAt: '2026-10-14T00:00:00Z' })).toEqual({ label: 'Analysed', tone: 'emerald' });
  });

  it('formats sizes up to gigabytes', () => {
    expect(formatBytesLong(512)).toBe('512 B');
    expect(formatBytesLong(40960)).toBe('40.0 KB');
    expect(formatBytesLong(8_500_000)).toBe('8.1 MB');
    expect(formatBytesLong(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});
