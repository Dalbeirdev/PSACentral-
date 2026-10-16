'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="-mx-1 mb-6 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-slate-200 px-1">
        {items.map((i) => {
          const active = i.href === '/settings' ? pathname === '/settings' : pathname.startsWith(i.href);
          return (
            <li key={i.href}>
              <Link
                href={i.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors',
                  active ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800',
                )}
              >
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
