import { cn } from '@/lib/cn';

/** Brand mark: three stacked "signal" bars inside a gradient tile — fleets reporting in. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn('brand-gradient relative inline-flex size-9 items-center justify-center rounded-xl shadow-[0_6px_16px_-6px_rgb(37_99_235/0.6),inset_0_1px_0_rgb(255_255_255/0.25)]', className)} aria-hidden="true">
      <svg viewBox="0 0 24 24" className="size-5 text-white" fill="none">
        <rect x="4" y="13" width="4" height="7" rx="1.6" fill="currentColor" fillOpacity="0.7" />
        <rect x="10" y="8.5" width="4" height="11.5" rx="1.6" fill="currentColor" fillOpacity="0.85" />
        <rect x="16" y="4" width="4" height="16" rx="1.6" fill="currentColor" />
      </svg>
    </span>
  );
}

export function Logo({ subtitle = 'Control Plane' }: { subtitle?: string }) {
  return (
    <span className="flex items-center gap-3">
      <LogoMark />
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight text-slate-900">PSA Control Center</span>
        <span className="block text-[11.5px] font-medium text-slate-500">{subtitle}</span>
      </span>
    </span>
  );
}
