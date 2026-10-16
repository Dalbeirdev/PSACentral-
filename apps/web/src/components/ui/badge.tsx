import type { DeploymentLifecycleState, HealthState } from '@psacc/contracts';
import { OctagonAlert, CircleCheck, CircleDashed, CircleQuestionMark, FlaskConical, TriangleAlert, WifiOff } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { humanize } from '@/lib/format';

type Tone = 'neutral' | 'blue' | 'cyan' | 'emerald' | 'violet' | 'amber' | 'red';

const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200/70',
  cyan: 'bg-cyan-50 text-cyan-700 ring-cyan-100',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200/70',
  violet: 'bg-violet-50 text-violet-700 ring-violet-100',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200/70',
  red: 'bg-red-50 text-red-700 ring-red-200/70',
};

export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium ring-1 ring-inset [&_svg]:size-3.5',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Marks development sample data. Never omitted on synthetic rows. */
export function SyntheticBadge({ className }: { className?: string }) {
  return (
    <Badge tone="amber" className={cn('h-5 gap-1 px-1.5 text-[11px]', className)} title="Synthetic development record — not a real installation">
      <FlaskConical aria-hidden="true" />
      Synthetic
    </Badge>
  );
}

const HEALTH: Record<HealthState, { tone: Tone; icon: ReactNode; label: string }> = {
  healthy: { tone: 'emerald', icon: <CircleCheck aria-hidden="true" />, label: 'Healthy' },
  degraded: { tone: 'amber', icon: <TriangleAlert aria-hidden="true" />, label: 'Degraded' },
  critical: { tone: 'red', icon: <OctagonAlert aria-hidden="true" />, label: 'Critical' },
  offline: { tone: 'neutral', icon: <WifiOff aria-hidden="true" />, label: 'Offline' },
  unknown: { tone: 'neutral', icon: <CircleQuestionMark aria-hidden="true" />, label: 'Unknown' },
};

/** Health status: icon + label + color (never color alone). */
export function HealthPill({ state, className }: { state: HealthState; className?: string }) {
  const h = HEALTH[state];
  return (
    <Badge tone={h.tone} className={cn(state === 'unknown' && 'bg-white text-slate-500 ring-slate-200', className)}>
      {h.icon}
      {h.label}
    </Badge>
  );
}

const LIFECYCLE_ORDER: DeploymentLifecycleState[] = ['draft', 'package_generated', 'package_downloaded', 'enrolled', 'verified'];
const LIFECYCLE_LABEL: Record<DeploymentLifecycleState, string> = {
  draft: 'Draft',
  package_generated: 'Package generated',
  package_downloaded: 'Package downloaded',
  enrolled: 'Enrolled',
  verified: 'Verified',
  suspended: 'Suspended',
  decommissioned: 'Decommissioned',
};

/** Compact lifecycle stage: 5-segment progress + label. Downloaded never reads as installed. */
export function LifecycleStage({ state }: { state: DeploymentLifecycleState }) {
  const idx = LIFECYCLE_ORDER.indexOf(state);
  const label = LIFECYCLE_LABEL[state] ?? humanize(state);
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <span className="flex gap-0.5" aria-hidden="true">
        {LIFECYCLE_ORDER.slice(1).map((s, i) => (
          <span
            key={s}
            className={cn(
              'h-1.5 w-3 rounded-full',
              idx < 0 ? 'bg-slate-200' : i < idx ? (idx === 4 ? 'bg-emerald-500' : 'bg-blue-500') : 'bg-slate-200',
            )}
          />
        ))}
      </span>
      <span className="text-[13px] text-slate-700">{label}</span>
      {state === 'draft' ? <CircleDashed className="size-3.5 text-slate-400" aria-hidden="true" /> : null}
    </span>
  );
}
