import { Compass } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="app-backdrop flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-white text-blue-600 shadow-card ring-1 ring-slate-200">
          <Compass className="size-7" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold text-blue-600">404</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">The page you are looking for does not exist or you do not have access to it.</p>
        <ButtonLink href="/dashboard" variant="primary" className="mt-6">
          Back to overview
        </ButtonLink>
      </div>
    </div>
  );
}
