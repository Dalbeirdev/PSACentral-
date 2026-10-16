import type { ReactNode } from 'react';

/** Label/value rows for detail cards. */
export function DetailRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2.5 text-sm">
          <dt className="text-slate-500">{k}</dt>
          <dd className="min-w-0 text-right font-medium text-slate-800">{v ?? <span className="font-normal text-slate-500">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
