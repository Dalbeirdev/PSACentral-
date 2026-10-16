'use client';

import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <ErrorState
        problem={{
          type: 'about:blank',
          title: 'Something went wrong',
          status: 500,
          detail: 'This page could not be displayed. Try again; if the problem continues, quote the reference below.',
          requestId: error.digest,
        }}
        action={
          <Button variant="secondary" onClick={reset}>
            <RefreshCw /> Try again
          </Button>
        }
      />
    </Card>
  );
}
