import { cn } from '@/lib/cn';

/** A measured percentage with the threshold colouring, or an honest "not measured". */
export function UsageBar({ label, value, warn, critical, className }: { label: string; value: number | null; warn: number; critical: number; className?: string }) {
  if (value === null) {
    return (
      <div className={cn('text-[12.5px] text-slate-500', className)}>
        <span className="font-medium text-slate-600">{label}</span> not measured
      </div>
    );
  }
  const tone = value >= critical ? 'bg-red-500' : value >= warn ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className={cn('min-w-28', className)}>
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="font-medium text-slate-600">{label}</span>
        <span className="tabular-nums font-semibold text-slate-900">{value}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" role="meter" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}
