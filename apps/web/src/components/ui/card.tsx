import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-2xl border border-slate-200/80 bg-white shadow-card', className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
  titleId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
  titleId?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon ? <div className="mt-0.5 text-slate-400 [&_svg]:size-[18px]">{icon}</div> : null}
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-slate-900">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-[13px] leading-5 text-slate-500">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 py-5 sm:px-6', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'footer'>) {
  return <footer className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sm:px-6', className)} {...props} />;
}
