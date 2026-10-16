import { Table2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/cn';

/** Chart container with an always-available data-table twin (WCAG equivalent of the chart). */
export function ChartCard({
  title,
  description,
  actions,
  children,
  table,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  table?: { columns: string[]; rows: (string | number)[][] };
  className?: string;
}) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader title={title} description={description} actions={actions} />
      <CardBody className="flex-1 pt-4">{children}</CardBody>
      {table ? (
        <details className="group border-t border-slate-100 px-5 py-3 sm:px-6">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-[12.5px] font-medium text-slate-500 hover:text-slate-800 [&::-webkit-details-marker]:hidden">
            <Table2 className="size-3.5" aria-hidden="true" />
            <span className="group-open:hidden">View data table</span>
            <span className="hidden group-open:inline">Hide data table</span>
          </summary>
          <div className="mt-3 max-h-64 overflow-auto rounded-lg ring-1 ring-slate-200">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">{title}</caption>
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  {table.columns.map((c) => (
                    <th key={c} scope="col" className="px-3 py-2 font-semibold text-slate-600">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tnum">
                {table.rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    {r.map((v, j) => (
                      <td key={j} className="px-3 py-1.5 text-slate-700">
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}

/** Ranked horizontal bar list (single series → single color; optional emphasis on one row). */
export function BarList({
  items,
  emphasize,
  ariaLabel,
  empty,
}: {
  items: { key: string; label: ReactNode; value: number; hint?: string }[];
  emphasize?: string;
  ariaLabel: string;
  empty?: ReactNode;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <>{empty}</>;
  return (
    <ul className="space-y-3" aria-label={ariaLabel}>
      {items.map((i) => {
        const strong = emphasize === undefined || emphasize === i.key;
        return (
          <li key={i.key} title={i.hint}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate font-medium text-slate-700">{i.label}</span>
              <span className="tnum font-semibold text-slate-900">{i.value}</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div
                className={cn('h-2 rounded-full', strong ? 'bg-blue-600' : 'bg-slate-300')}
                style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
