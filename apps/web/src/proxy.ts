import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIES = ['psacc_session', '__Host-psacc_session'];
const PUBLIC_PATHS = ['/login'];

/**
 * Runs before every page request:
 *  - per-request nonce Content-Security-Policy (scripts must carry the nonce)
 *  - cheap redirect to /login when no session cookie is present
 *    (the real session check happens server-side against the API on every render)
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = SESSION_COOKIES.some((c) => request.cookies.has(c));

  if (!isPublic && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' || pathname === '/dashboard' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV === 'development';
  const https = request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
