'use client';

import type { ProblemDetails } from '@psacc/contracts';

export type MutationResult<T> = { ok: true; data: T } | { ok: false; status: number; problem: ProblemDetails };

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function csrfToken(): string | null {
  return readCookie('__Host-psacc_csrf') ?? readCookie('psacc_csrf');
}

/** Browser → same-origin /api (proxied to the Control Plane). Adds the CSRF header on every call. */
export async function apiMutate<T = void>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<MutationResult<T>> {
  const token = csrfToken();
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, status: 0, problem: { type: 'network', title: 'Network error', status: 0, detail: 'Could not reach the server. Check your connection and try again.' } };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  const json = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: json as T };
  return { ok: false, status: res.status, problem: (json as ProblemDetails) ?? { type: 'about:blank', title: res.statusText, status: res.status } };
}

/** Browser GET against the same-origin API (used for live checks such as duplicate detection). */
export async function apiQuery<T>(path: string, signal?: AbortSignal): Promise<MutationResult<T>> {
  try {
    const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal });
    const json = await res.json().catch(() => null);
    if (res.ok) return { ok: true, data: json as T };
    return { ok: false, status: res.status, problem: (json as ProblemDetails) ?? { type: 'about:blank', title: res.statusText, status: res.status } };
  } catch {
    return { ok: false, status: 0, problem: { type: 'network', title: 'Network error', status: 0 } };
  }
}

/** Runs a zod schema and returns { 'a.b.0.c': message } for inline field errors. */
export function zodErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.map(String).join('.');
    if (!(key in out)) out[key] = i.message;
  }
  return out;
}

/**
 * Full navigation after a session/authorization change (sign-in steps, sign-out, role edits),
 * so every server component re-renders with the new cookie and no client cache is reused.
 */
export function navigateTo(path: string): void {
  window.location.assign(path);
}

/** Maps API validation errors to a { field: message } record for inline display. */
export function fieldErrors(problem: ProblemDetails | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of problem?.errors ?? []) if (!out[e.path]) out[e.path] = e.message;
  return out;
}

/**
 * POST that returns a file (deployment packages). Uses fetch so the CSRF header is sent and nothing
 * sensitive appears in a URL; the browser then saves the blob under the server's file name.
 */
export async function apiDownload(path: string): Promise<{ ok: true; fileName: string; sha256: string | null } | { ok: false; status: number; problem: ProblemDetails }> {
  const token = csrfToken();
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/zip, application/problem+json', ...(token ? { 'x-csrf-token': token } : {}) } });
  } catch {
    return { ok: false, status: 0, problem: { type: 'network', title: 'Network error', status: 0, detail: 'Could not reach the server. Check your connection and try again.' } };
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    return { ok: false, status: res.status, problem: (json as ProblemDetails) ?? { type: 'about:blank', title: res.statusText, status: res.status } };
  }
  const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'deployment-package.zip';
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { ok: true, fileName, sha256: res.headers.get('x-content-sha256') };
}
