import { ArrowLeft, CircleDashed, Construction } from 'lucide-react';
import { notFound } from 'next/navigation';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { can, requireActiveSession } from '@/lib/api-server';
import { ALL_NAV_ITEMS, PLANNED } from '@/lib/nav';

/**
 * Honest placeholder for sections delivered by later modules. It has no functional controls,
 * so nothing here pretends to work.
 */
export async function PlannedModulePage({ section, subpath }: { section: string; subpath?: string[] }) {
  const info = PLANNED[section];
  if (!info) notFound();
  const me = await requireActiveSession();
  const nav = ALL_NAV_ITEMS.find((i) => i.href === `/${section}`);
  if (nav?.permission && !can(me, nav.permission)) notFound();
  const deep = subpath && subpath.length > 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Overview', href: '/dashboard' }, { label: info.title, href: `/${section}` }, ...(deep ? [{ label: 'Detail' }] : [])]}
        title={info.title}
        description={info.summary}
        eyebrow={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
            <Construction className="size-3.5 text-amber-600" aria-hidden="true" /> Planned · Module {info.module}
          </span>
        }
      />
      <Card className="overflow-hidden">
        <div className="grid gap-0 md:grid-cols-[1.1fr_1fr]">
          <div className="p-6 sm:p-8">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">Not available in this build</h2>
            <p className="mt-2 max-w-prose text-sm leading-6 text-slate-500">
              {deep
                ? 'Detail pages for this section are delivered with its module. The record you followed exists in the control plane database, but its dedicated page has not been built yet.'
                : 'This section is part of the approved roadmap. It is visible in navigation so the platform structure is clear, but it has no working controls until its module is implemented and tested.'}
            </p>
            <ButtonLink href="/dashboard" variant="secondary" className="mt-6">
              <ArrowLeft /> Back to overview
            </ButtonLink>
          </div>
          <div className="border-t border-slate-100 bg-slate-50/70 p-6 sm:p-8 md:border-l md:border-t-0">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">Scope of Module {info.module}</p>
            <ul className="mt-4 space-y-3">
              {info.capabilities.map((c) => (
                <li key={c} className="flex gap-3 text-sm leading-6 text-slate-700">
                  <CircleDashed className="mt-1 size-4 shrink-0 text-slate-400" aria-hidden="true" />
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </>
  );
}
