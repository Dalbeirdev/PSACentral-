import type { SearchResponse } from '@psacc/contracts';
import { Building, Plug, Rocket, SearchX } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SyntheticBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { apiGet, requireActiveSession } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Search' };

const TYPE = {
  client: { label: 'Clients', icon: Building, tint: 'bg-blue-50 text-blue-600 ring-blue-100' },
  deployment: { label: 'Deployments', icon: Rocket, tint: 'bg-cyan-50 text-cyan-600 ring-cyan-100' },
  psa_instance: { label: 'PSA instances', icon: Plug, tint: 'bg-violet-50 text-violet-600 ring-violet-100' },
} as const;

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireActiveSession();
  const raw = (await searchParams).q;
  const q = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
  const result = q.length >= 2 ? await apiGet<SearchResponse>(`/search?q=${encodeURIComponent(q)}`) : null;

  return (
    <>
      <PageHeader breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: 'Search' }]} title={q ? `Results for “${q}”` : 'Search'} description="Searches clients, deployments and PSA instances you have access to." />
      {!result ? (
        <Card><EmptyState title="Type at least 2 characters" description="Use the search box at the top of every page." /></Card>
      ) : !result.ok ? (
        <Card><ErrorState problem={result.problem} /></Card>
      ) : result.data.results.length === 0 ? (
        <Card><EmptyState icon={<SearchX />} title="No matches" description="Try a client name, reference, or a code such as DEP-00012." /></Card>
      ) : (
        <div className="space-y-4">
          {(Object.keys(TYPE) as (keyof typeof TYPE)[]).map((type) => {
            const items = result.data.results.filter((r) => r.type === type);
            if (!items.length) return null;
            const T = TYPE[type];
            return (
              <Card key={type} className="overflow-hidden">
                <h2 className="border-b border-slate-100 px-5 py-3 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-500 sm:px-6">
                  {T.label} · {items.length}
                </h2>
                <ul className="divide-y divide-slate-100">
                  {items.map((r) => (
                    <li key={r.id}>
                      <Link href={r.href} className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-slate-50 sm:px-6">
                        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${T.tint}`}>
                          <T.icon className="size-[18px]" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-slate-900">{r.title}</span>
                            {r.isSynthetic ? <SyntheticBadge /> : null}
                          </span>
                          <span className="block truncate text-[13px] text-slate-500">{r.subtitle}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
