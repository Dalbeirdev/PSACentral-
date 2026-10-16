import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'blue' | 'cyan' | 'violet' | 'emerald' | 'red' | 'amber' | 'slate';

const TONES: Record<Tone, string> = {
  blue: 'bg-blue-50 text-blue-600 ring-blue-100',
  cyan: 'bg-cyan-50 text-cyan-600 ring-cyan-100',
  violet: 'bg-violet-50 text-violet-600 ring-violet-100',
  emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
  red: 'bg-red-50 text-red-600 ring-red-100',
  amber: 'bg-amber-50 text-amber-600 ring-amber-100',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function KpiCard({
  label,
  value,
  icon,
  tone,
  context,
  href,
  meter,
  testId,
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tone: Tone;
  context: ReactNode;
  href: string;
  /** Optional 0..1 share shown as a slim meter (e.g. healthy / active). */
  meter?: { value: number; label: string };
  testId?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="group relative flex flex-col rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-px hover:border-slate-300/80 hover:shadow-card-hover"
    >
      <div className="flex items-start justify-between">
        <span className={cn('flex size-10 items-center justify-center rounded-xl ring-1 ring-inset [&_svg]:size-5', TONES[tone])} aria-hidden="true">
          {icon}
        </span>
        <ArrowUpRight className="size-4 text-slate-300 transition-colors group-hover:text-slate-500" aria-hidden="true" />
      </div>
      <p className="mt-4 text-[13px] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-[30px] font-semibold leading-9 tracking-tight text-slate-900" data-testid={testId ? `${testId}-value` : undefined}>
        {value}
      </p>
      {meter ? (
        <div className="mt-2" title={meter.label}>
          <div className="h-1.5 rounded-full bg-slate-100">
            <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${Math.round(Math.min(1, Math.max(0, meter.value)) * 100)}%` }} />
          </div>
        </div>
      ) : null}
      <p className="mt-2 text-[12.5px] leading-5 text-slate-500">{context}</p>
    </Link>
  );
}
