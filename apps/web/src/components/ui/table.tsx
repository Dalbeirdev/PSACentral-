import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Table({ className, children, ...props }: ComponentProps<'table'>) {
  return (
    <div className="-mx-px overflow-x-auto">
      <table className={cn('w-full min-w-[640px] border-separate border-spacing-0 text-left text-sm', className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-b border-slate-200 bg-slate-50/80 px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-slate-500 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('border-b border-slate-100 px-4 py-3 align-middle text-slate-700 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6', className)} {...props} />;
}

export function Tr({ className, children, ...props }: ComponentProps<'tr'>) {
  return (
    <tr className={cn('transition-colors last:[&>td]:border-b-0 hover:bg-slate-50/70', className)} {...props}>
      {children}
    </tr>
  );
}

/** Column header that links to the same page with ?sort=field:dir (server-side sorting). */
export function SortTh({
  field,
  label,
  current,
  hrefFor,
  className,
}: {
  field: string;
  label: string;
  current: string | undefined;
  hrefFor: (sort: string) => string;
  className?: string;
}) {
  const [cf, cd] = (current ?? '').split(':');
  const active = cf === field;
  const next = active && cd === 'asc' ? 'desc' : 'asc';
  return (
    <Th className={className} aria-sort={active ? (cd === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <Link href={hrefFor(`${field}:${next}`)} className="inline-flex items-center gap-1 hover:text-slate-800">
        {label}
        {active ? (cd === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-50" />}
      </Link>
    </Th>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
  label = 'results',
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
  label?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const link = (p: number, children: ReactNode, aria: string) =>
    p < 1 || p > pages ? (
      <span aria-disabled="true" className="inline-flex size-8 items-center justify-center rounded-lg text-slate-300">
        {children}
      </span>
    ) : (
      <Link href={hrefFor(p)} aria-label={aria} className="inline-flex size-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900">
        {children}
      </Link>
    );
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-3 text-[13px] text-slate-500 sm:px-6">
      <p className="tnum">
        Showing <span className="font-medium text-slate-700">{from}</span>–<span className="font-medium text-slate-700">{to}</span> of{' '}
        <span className="font-medium text-slate-700">{total}</span> {label}
      </p>
      <div className="flex items-center gap-1">
        {link(page - 1, <ChevronLeft className="size-4" />, 'Previous page')}
        <span className="tnum px-2">
          Page {page} of {pages}
        </span>
        {link(page + 1, <ChevronRight className="size-4" />, 'Next page')}
      </div>
    </nav>
  );
}
