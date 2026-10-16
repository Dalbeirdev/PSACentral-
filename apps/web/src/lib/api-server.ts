import type { MeResponse, ProblemDetails, SystemInfo } from '@psacc/contracts';
import { SESSION_STATE_ROUTES } from '@psacc/contracts';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';

const API = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4210';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; problem: ProblemDetails };

/**
 * Server-side API call on behalf of the signed-in user (forwards the session cookie and the
 * client IP so per-IP rate limits and audit IPs stay accurate). Never cached.
 */
export async function apiFetch<T>(path: string): Promise<ApiResult<T>> {
  const cookieStore = await cookies();
  const h = await headers();
  const forwardedFor = h.get('x-forwarded-for');
  let res: Response;
  try {
    res = await fetch(`${API}/api/v1${path}`, {
      headers: {
        cookie: cookieStore.toString(),
        accept: 'application/json',
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      status: 503,
      problem: { type: 'urn:psacc:problem:api-unreachable', title: 'Control Plane API unreachable', status: 503, detail: 'The web server could not reach the Control Plane API.' },
    };
  }
  if (res.ok) return { ok: true, data: (await res.json()) as T };
  const problem = (await res.json().catch(() => ({ type: 'about:blank', title: res.statusText, status: res.status }))) as ProblemDetails;
  return { ok: false, status: res.status, problem };
}

/** Like apiFetch, but redirects to sign-in when the session is missing/expired. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const r = await apiFetch<T>(path);
  if (!r.ok && r.status === 401) redirect('/login?expired=1');
  return r;
}

/** Current user for this request (deduplicated across layout + page). */
export const getMe = cache(async (): Promise<MeResponse> => {
  const r = await apiFetch<MeResponse>('/auth/me');
  if (!r.ok) redirect(r.status === 401 ? '/login?expired=1' : '/login');
  return r.data;
});

/** Requires a fully signed-in session; otherwise sends the user to the pending sign-in step. */
export async function requireActiveSession(): Promise<MeResponse> {
  const me = await getMe();
  if (me.session.state !== 'active') redirect(SESSION_STATE_ROUTES[me.session.state]);
  return me;
}

export const getSystemInfo = cache(async (): Promise<SystemInfo | null> => {
  try {
    const res = await fetch(`${API}/api/v1/system/info`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as SystemInfo) : null;
  } catch {
    return null;
  }
});

export function can(me: MeResponse, permission: string): boolean {
  return (me.permissions as string[]).includes(permission);
}
