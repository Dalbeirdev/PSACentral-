import type { TableInventoryRow } from '@psacc/contracts';

/** `schema.table` reference used in explorer URLs (the first dot separates the schema). */
export function tableRef(schema: string, name: string): string {
  return `${schema}.${name}`;
}

export function parseTableRef(ref: string): { schema: string; name: string } | null {
  const i = ref.indexOf('.');
  if (i <= 0 || i === ref.length - 1 || ref.length > 130) return null;
  return { schema: ref.slice(0, i), name: ref.slice(i + 1) };
}

/** Planner estimates are never shown as exact counts. */
export function formatEstimate(n: number | null): string {
  return n === null ? 'not analysed' : `≈ ${n.toLocaleString('en-US')}`;
}

export type TableStatus = { label: string; tone: 'emerald' | 'amber' | 'neutral' | 'blue' };

/** What the Control Plane knows about a table: whether statistics exist and whether details arrived. */
export function tableStatus(t: Pick<TableInventoryRow, 'estimatedRows' | 'detailsObservedAt'>): TableStatus {
  if (!t.detailsObservedAt) return { label: 'Details pending', tone: 'amber' };
  if (t.estimatedRows === null) return { label: 'Never analysed', tone: 'neutral' };
  return { label: 'Analysed', tone: 'emerald' };
}

export function formatBytesLong(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
