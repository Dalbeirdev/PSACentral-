import type { MeResponse } from '@psacc/contracts';
import { SESSION_STATE_ROUTES } from '@psacc/contracts';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { apiFetch } from '@/lib/api-server';
import { safeNextPath } from '@/lib/format';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const store = await cookies();
  if (store.has('psacc_session') || store.has('__Host-psacc_session')) {
    const me = await apiFetch<MeResponse>('/auth/me');
    if (me.ok) redirect(me.data.session.state === 'active' ? (safeNextPath(params.next) ?? '/dashboard') : SESSION_STATE_ROUTES[me.data.session.state]);
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h1>
      <p className="mt-1.5 text-sm text-slate-500">Use your PSA Control Center account.</p>
      <div className="mt-6 space-y-3">
        {params.expired ? <Alert variant="warning">Your session ended. Sign in again to continue.</Alert> : null}
        {params.signedOut ? <Alert variant="success">You have been signed out.</Alert> : null}
      </div>
      <LoginForm next={safeNextPath(params.next)} />
    </>
  );
}
