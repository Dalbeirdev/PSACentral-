import type { MeResponse, SessionState } from '@psacc/contracts';
import { SESSION_STATE_ROUTES } from '@psacc/contracts';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api-server';

/** Only lets the user see the sign-in step that matches their session state. */
export async function requireStep(state: SessionState): Promise<MeResponse> {
  const me = await apiFetch<MeResponse>('/auth/me');
  if (!me.ok) redirect('/login?expired=1');
  if (me.data.session.state !== state) redirect(SESSION_STATE_ROUTES[me.data.session.state]);
  return me.data;
}
