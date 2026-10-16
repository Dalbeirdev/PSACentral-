import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn('text-[13px]', className)}>
      <ol className="flex flex-wrap items-center gap-1 text-slate-500">
        {items.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3.5 text-slate-300" aria-hidden="true" /> : null}
            {c.href && i < items.length - 1 ? (
              <Link href={c.href} className="rounded hover:text-slate-900">
                {c.label}
              </Link>
            ) : (
              <span aria-current={i === items.length - 1 ? 'page' : undefined} className={i === items.length - 1 ? 'font-medium text-slate-700' : ''}>
                {c.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 sm:mb-8">
      {breadcrumbs ? <Breadcrumbs items={breadcrumbs} className="mb-3" /> : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? <div className="mb-2">{eyebrow}</div> : null}
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-[28px] sm:leading-9">{title}</h1>
          {description ? <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500 sm:text-[15px]">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
