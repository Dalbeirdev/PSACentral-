import { CircleAlert, CircleCheck, FlaskConical, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'info' | 'success' | 'warning' | 'error' | 'synthetic';

const styles: Record<Variant, { box: string; icon: ReactNode }> = {
  info: { box: 'border-blue-200/80 bg-blue-50/70 text-blue-900 [&_.alert-icon]:text-blue-600', icon: <Info /> },
  success: { box: 'border-emerald-200 bg-emerald-50/80 text-emerald-900 [&_.alert-icon]:text-emerald-600', icon: <CircleCheck /> },
  warning: { box: 'border-amber-200 bg-amber-50/80 text-amber-900 [&_.alert-icon]:text-amber-600', icon: <TriangleAlert /> },
  error: { box: 'border-red-200 bg-red-50/80 text-red-900 [&_.alert-icon]:text-red-600', icon: <CircleAlert /> },
  synthetic: { box: 'border-amber-200/90 bg-gradient-to-r from-amber-50 to-white text-amber-950 [&_.alert-icon]:text-amber-600', icon: <FlaskConical /> },
};

/** Inline, persistent status message. The product's only notification mechanism (no toasts). */
export function Alert({
  variant = 'info',
  title,
  children,
  actions,
  className,
  role,
}: {
  variant?: Variant;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  const s = styles[variant];
  return (
    <div
      role={role ?? (variant === 'error' ? 'alert' : 'status')}
      className={cn('flex gap-3 rounded-xl border px-4 py-3 text-sm', s.box, className)}
    >
      <span className="alert-icon mt-0.5 shrink-0 [&_svg]:size-[18px]" aria-hidden="true">
        {s.icon}
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn('leading-6', title && 'mt-0.5 opacity-90')}>{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
