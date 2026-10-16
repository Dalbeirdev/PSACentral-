import type { ProblemDetails } from '@psacc/contracts';
import { CircleAlert, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 ring-8 ring-slate-50 [&_svg]:size-6">
        {icon ?? <Inbox />}
      </div>
      <p className="text-[15px] font-semibold text-slate-900">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ problem, title, className, action }: { problem: ProblemDetails; title?: string; className?: string; action?: ReactNode }) {
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-600 ring-8 ring-red-50/50 [&_svg]:size-6">
        <CircleAlert />
      </div>
      <p className="text-[15px] font-semibold text-slate-900">{title ?? problem.title}</p>
      {problem.detail ? <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">{problem.detail}</p> : null}
      {problem.requestId ? (
        <p className="mt-3 font-mono text-xs text-slate-500">
          Request ID <span className="select-all text-slate-500">{problem.requestId}</span>
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-shimmer rounded-lg bg-slate-200/70', className)} />;
}
