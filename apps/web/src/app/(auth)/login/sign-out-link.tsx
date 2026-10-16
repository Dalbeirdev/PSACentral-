'use client';

import { useState } from 'react';
import { apiMutate, navigateTo } from '@/lib/api-client';

export function SignOutLink({ label = 'Use a different account' }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="text-sm font-medium text-slate-500 underline-offset-4 hover:text-slate-900 hover:underline"
      onClick={async () => {
        setBusy(true);
        await apiMutate('POST', '/auth/logout');
        navigateTo('/login');
      }}
    >
      {label}
    </button>
  );
}
