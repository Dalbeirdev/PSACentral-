// Throttle decorators are evaluated at import time, before configuration is loaded,
// so limits are resolved lazily per request from the (already validated) environment.
const perMinute = (name: string, fallback: number) => () => Number(process.env[name] ?? fallback);

/** Credential-bearing endpoints (login, MFA, password change): per IP. */
export const loginRateLimit = { ttl: 60_000, limit: perMinute('LOGIN_RATE_LIMIT_PER_MINUTE', 10) };

/** Everything else: per IP. */
export const defaultRateLimit = { ttl: 60_000, limit: perMinute('RATE_LIMIT_PER_MINUTE', 300) };

/** Package generation and download (token-bearing archives): per IP. */
export const packageRateLimit = { ttl: 60_000, limit: perMinute('PACKAGE_RATE_LIMIT_PER_MINUTE', 30) };
