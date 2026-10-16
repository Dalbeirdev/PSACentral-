'use client';

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/** Re-fetches server data for the current page without a full reload or layout jump. */
export function RefreshButton({ label = 'Refresh' }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="secondary" size="sm" onClick={() => start(() => router.refresh())} aria-busy={pending || undefined}>
      <RefreshCw className={cn(pending && 'animate-spin')} aria-hidden="true" />
      {pending ? 'Refreshing…' : label}
    </Button>
  );
}
