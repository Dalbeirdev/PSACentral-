'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '@/lib/cn';

const control =
  'block w-full rounded-lg border bg-white px-3 text-sm text-slate-900 shadow-[0_1px_2px_rgb(15_23_42/0.04)] transition-[border-color,box-shadow] placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-600/12 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500';

export function inputClass(invalid?: boolean, className?: string) {
  return cn(control, 'h-10', invalid ? 'border-red-300 focus:border-red-500 focus:ring-red-500/12' : 'border-slate-200 hover:border-slate-300', className);
}

export function Input({ invalid, className, ...props }: ComponentProps<'input'> & { invalid?: boolean }) {
  return <input className={inputClass(invalid, className)} aria-invalid={invalid || undefined} {...props} />;
}

export function Textarea({ invalid, className, rows = 3, ...props }: ComponentProps<'textarea'> & { invalid?: boolean }) {
  return (
    <textarea
      rows={rows}
      className={cn(control, 'py-2', invalid ? 'border-red-300 focus:border-red-500 focus:ring-red-500/12' : 'border-slate-200 hover:border-slate-300', className)}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}

export function Select({ invalid, className, children, ...props }: ComponentProps<'select'> & { invalid?: boolean }) {
  return (
    <select
      className={cn(
        inputClass(invalid, className),
        'appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 20 20%27 fill=%27%2364748b%27%3E%3Cpath d=%27M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z%27/%3E%3C/svg%3E")] bg-[length:18px] bg-[right_0.6rem_center] bg-no-repeat pr-9',
      )}
      aria-invalid={invalid || undefined}
      {...props}
    >
      {children}
    </select>
  );
}

/**
 * Label + control + hint + inline error, wired with aria-describedby.
 * `children` receives the generated id and describedby.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: (p: { id: string; 'aria-describedby'?: string; 'aria-required'?: boolean; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      {/* The required marker is drawn by CSS so it is not part of the accessible name; aria-required conveys it. */}
      <label htmlFor={id} className={cn('block text-[13px] font-medium text-slate-700', required && "after:ml-0.5 after:text-red-600 after:content-['*']")}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, ...(required ? { 'aria-required': true } : {}), invalid: !!error })}
      {hint && !error ? (
        <p id={hintId} className="text-xs leading-5 text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs font-medium leading-5 text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, description, className, ...props }: ComponentProps<'input'> & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={props.id ?? id} className={cn('flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5 transition-colors hover:border-slate-300 has-[:checked]:border-blue-300 has-[:checked]:bg-blue-50/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60', className)}>
      <input id={props.id ?? id} type="checkbox" className="mt-0.5 size-4 shrink-0 rounded border-slate-300 accent-blue-600" {...props} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900">{label}</span>
        {description ? <span className="mt-0.5 block text-xs leading-5 text-slate-500">{description}</span> : null}
      </span>
    </label>
  );
}
