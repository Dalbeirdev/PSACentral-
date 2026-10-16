import { ONBOARDING_STEPS, type OnboardingDraftDto, type OnboardingStepKey } from '@psacc/contracts';
import { Check, Lock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/cn';
import { formatDateTime, relativeTime } from '@/lib/format';
import { availability, stepHref } from '@/lib/wizard';

export function WizardFrame({ draft, step, timezone, children }: { draft: OnboardingDraftDto; step: OnboardingStepKey; timezone: string; children: ReactNode }) {
  const current = ONBOARDING_STEPS.find((s) => s.key === step)!;
  const clientName = draft.data.client?.company.displayName;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Onboard client', href: '/clients/new' }, { label: clientName ?? 'New client' }]}
        eyebrow={<span className="text-sm font-medium text-blue-700">Step {current.number} of {ONBOARDING_STEPS.length}</span>}
        title={current.title}
        description={
          <>
            {clientName ? <span className="font-medium text-slate-700">{clientName} · </span> : null}
            {draft.status === 'completed' ? 'Records created. ' : 'Draft saved on the server. '}
            <span title={formatDateTime(draft.updatedAt, timezone)}>
              Last saved {relativeTime(draft.updatedAt)}{draft.updatedBy ? ` by ${draft.updatedBy.displayName}` : ''}.
            </span>
          </>
        }
      />

      {/* Compact progress for small screens */}
      <div className="mb-4 lg:hidden" aria-hidden="true">
        <div className="flex gap-1">
          {ONBOARDING_STEPS.map((s) => {
            const a = availability(draft, s.key, step);
            return <span key={s.key} className={cn('h-1.5 flex-1 rounded-full', a === 'done' ? 'bg-emerald-500' : a === 'current' ? 'bg-blue-600' : 'bg-slate-200')} />;
          })}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <nav aria-label="Onboarding steps" className="hidden lg:block">
          <Card className="p-3">
            <ol className="space-y-0.5">
              {ONBOARDING_STEPS.map((s) => {
                const a = availability(draft, s.key, step);
                const content = (
                  <>
                    <span
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                        a === 'done' && 'bg-emerald-500 text-white',
                        a === 'current' && 'bg-blue-600 text-white ring-4 ring-blue-100',
                        a === 'open' && 'bg-white text-slate-600 ring-1 ring-slate-300',
                        a === 'locked' && 'bg-slate-100 text-slate-500',
                      )}
                      aria-hidden="true"
                    >
                      {a === 'done' ? <Check className="size-3.5" /> : a === 'locked' ? <Lock className="size-3" /> : s.number}
                    </span>
                    <span className="min-w-0">
                      <span className={cn('block truncate text-[13.5px]', a === 'current' ? 'font-semibold text-blue-700' : a === 'locked' ? 'text-slate-500' : 'font-medium text-slate-700')}>
                        {s.title}
                      </span>
                      <span className="sr-only">
                        {a === 'done' ? '(completed)' : a === 'current' ? '(current step)' : a === 'locked' ? '(not available yet)' : '(available)'}
                      </span>
                    </span>
                  </>
                );
                const linkable = a === 'open' || (a === 'done' && draft.status !== 'completed');
                return (
                  <li key={s.key}>
                    {linkable ? (
                      <Link href={stepHref(draft.id, s.key)} className="flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-slate-50">
                        {content}
                      </Link>
                    ) : (
                      <span aria-current={a === 'current' ? 'step' : undefined} className={cn('flex items-center gap-3 rounded-lg px-2.5 py-2', a === 'current' && 'bg-blue-50/70')}>
                        {content}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </Card>
          <p className="mt-3 px-1 text-xs leading-5 text-slate-500">
            Each step is saved when you continue. <Link href="/clients/new" className="font-medium text-blue-700 hover:underline">Exit to drafts</Link>
          </p>
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}

export function StepCard({ title, description, children, footer }: { title?: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card>
      {title ? (
        <div className="border-b border-slate-100 px-5 py-4 sm:px-8">
          <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
          {description ? <p className="mt-0.5 text-[13px] leading-5 text-slate-500">{description}</p> : null}
        </div>
      ) : null}
      <div className="px-5 py-6 sm:px-8">{children}</div>
      {footer ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 sm:px-8">{footer}</div> : null}
    </Card>
  );
}
