'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export interface SectionTab {
  href: string;
  label: string;
  count?: number;
  exact?: boolean;
}

/** Sub-page navigation (links, not client-side tab panels): each section has its own URL. */
export function SectionTabs({ tabs, label }: { tabs: SectionTab[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mx-1 mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-slate-200 px-1">
        {tabs.map((t) => {
          const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors',
                  active ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
                )}
              >
                {t.label}
                {t.count !== undefined ? (
                  <span className={cn('rounded-full px-1.5 text-[11px] font-semibold', active ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600')}>{t.count}</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
