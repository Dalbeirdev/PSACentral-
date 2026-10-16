import { readFileSync } from 'node:fs';
import { APP_ENVIRONMENTS, type AppEnvironment } from '@psacc/contracts';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const base64Key = (bytes: number, exact: boolean) =>
  z.string().refine((v) => {
    const len = Buffer.from(v, 'base64').length;
    return exact ? len === bytes : len >= bytes;
  }, `must be base64 encoding ${exact ? 'exactly' : 'at least'} ${bytes} bytes`);

const envSchema = z
  .object({
    APP_ENV: z.enum(APP_ENVIRONMENTS),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4210),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TRUST_PROXY: z.string().default('loopback'),
    APP_ALLOWED_ORIGINS: z
      .string()
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(z.array(z.url()).min(1)),
    OPENAPI_ENABLED: bool.default(false),
    AUTH_MFA_REQUIRED: bool.default(true),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
    LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
    CSRF_SECRET: base64Key(32, false),
    DATA_ENCRYPTION_KEY: base64Key(32, true),
    // Module 16: Ed25519 seed that signs appliance license tokens; its public key is pinned in edge images.
    LICENSE_SIGNING_KEY: base64Key(32, true),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
    // Standard PSA Edge image referenced by generated deployment packages (one image for every client).
    EDGE_IMAGE_REPOSITORY: z.string().regex(/^[a-z0-9]+([._/-][a-z0-9]+)*$/, 'must be an image repository like psacc/psa-edge').default('psacc/psa-edge'),
    EDGE_IMAGE_VERSION: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/, 'must be a semantic version').default('0.1.0'),
    // Digest of the signed, published image. Empty until an image is published (Module 6/10).
    EDGE_IMAGE_DIGEST: z.union([z.literal(''), z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 hex>')]).default(''),
    // Agent gateway (mTLS, Module 7) that edge agents dial out to. Always https.
    AGENT_GATEWAY_URL: z.url().refine((u) => u.startsWith('https://'), 'must be an https:// URL').default('https://localhost:8443'),
    EDGE_HEARTBEAT_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
    // The gateway's own listener (mTLS for everything but enrollment). Disable it where it is not needed.
    AGENT_GATEWAY_ENABLED: bool.default(true),
    AGENT_GATEWAY_HOST: z.string().default('127.0.0.1'),
    AGENT_GATEWAY_PORT: z.coerce.number().int().min(0).max(65535).optional(),
    // Extra DNS names / IPs for the gateway's TLS certificate (comma-separated), besides the URL's host.
    AGENT_GATEWAY_EXTRA_NAMES: z.string().default(''),
    AGENT_CERT_DAYS: z.coerce.number().int().min(1).max(397).default(90),
    AGENT_ENROLL_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
  })
  .superRefine((env, ctx) => {
    const hardened = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
    if (!hardened) return;
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!env.AUTH_MFA_REQUIRED) issue('AUTH_MFA_REQUIRED', 'must be true in staging/production');
    if (env.APP_ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))) {
      issue('APP_ALLOWED_ORIGINS', 'all origins must use https in staging/production');
    }
    const dbUser = decodeURIComponent(new URL(env.DATABASE_URL).username);
    if (dbUser === 'postgres' || dbUser.endsWith('_owner')) {
      issue('DATABASE_URL', 'the API must not connect as a superuser or schema owner');
    }
    if (process.env.SEED_DEFAULT_PASSWORD) issue('SEED_DEFAULT_PASSWORD', 'must not be set in staging/production');
    if (/^https:\/\/(localhost|127\.|\[::1\])/.test(env.AGENT_GATEWAY_URL)) issue('AGENT_GATEWAY_URL', 'must be the public gateway address in staging/production');
    if (!env.EDGE_IMAGE_DIGEST) issue('EDGE_IMAGE_DIGEST', 'production packages must pin the signed edge image by digest');
  });

export interface AppConfig {
  env: AppEnvironment;
  version: string;
  host: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  trustProxy: string;
  allowedOrigins: string[];
  openApiEnabled: boolean;
  auth: {
    mfaRequired: boolean;
    sessionIdleMinutes: number;
    sessionAbsoluteHours: number;
    loginMaxFailures: number;
    loginLockMinutes: number;
    loginRateLimitPerMinute: number;
    secureCookies: boolean;
    sessionCookieName: string;
    csrfCookieName: string;
  };
  rateLimitPerMinute: number;
  secrets: { csrfSecret: Buffer; dataEncryptionKey: Buffer; licenseSigningKey: Buffer };
  database: { url: string; poolMax: number; statementTimeoutMs: number };
  edge: { imageRepository: string; imageVersion: string; imageDigest: string | null; agentGatewayUrl: string; heartbeatSeconds: number };
  gateway: { enabled: boolean; host: string; port: number; names: string[]; certificateDays: number; enrollPerMinute: number };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export class ConfigError extends Error {}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const hardened = e.APP_ENV === 'staging' || e.APP_ENV === 'production';
  return {
    env: e.APP_ENV,
    version: readVersion(),
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    allowedOrigins: e.APP_ALLOWED_ORIGINS.map((o) => new URL(o).origin),
    openApiEnabled: e.OPENAPI_ENABLED,
    auth: {
      mfaRequired: e.AUTH_MFA_REQUIRED,
      sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
      sessionAbsoluteHours: e.SESSION_ABSOLUTE_HOURS,
      loginMaxFailures: e.LOGIN_MAX_FAILURES,
      loginLockMinutes: e.LOGIN_LOCK_MINUTES,
      loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
      secureCookies: hardened,
      // __Host- prefix requires Secure + Path=/ + no Domain: only possible over HTTPS.
      sessionCookieName: hardened ? '__Host-psacc_session' : 'psacc_session',
      csrfCookieName: hardened ? '__Host-psacc_csrf' : 'psacc_csrf',
    },
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    secrets: {
      csrfSecret: Buffer.from(e.CSRF_SECRET, 'base64'),
      dataEncryptionKey: Buffer.from(e.DATA_ENCRYPTION_KEY, 'base64'),
      licenseSigningKey: Buffer.from(e.LICENSE_SIGNING_KEY, 'base64'),
    },
    database: { url: e.DATABASE_URL, poolMax: e.DB_POOL_MAX, statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS },
    edge: {
      imageRepository: e.EDGE_IMAGE_REPOSITORY,
      imageVersion: e.EDGE_IMAGE_VERSION,
      imageDigest: e.EDGE_IMAGE_DIGEST || null,
      agentGatewayUrl: e.AGENT_GATEWAY_URL.replace(/\/+$/, ''),
      heartbeatSeconds: e.EDGE_HEARTBEAT_SECONDS,
    },
    gateway: {
      enabled: e.AGENT_GATEWAY_ENABLED,
      host: e.AGENT_GATEWAY_HOST,
      port: e.AGENT_GATEWAY_PORT ?? Number(new URL(e.AGENT_GATEWAY_URL).port || 443),
      names: [...new Set([new URL(e.AGENT_GATEWAY_URL).hostname.replace(/^\[|\]$/g, ''), 'localhost', '127.0.0.1', ...e.AGENT_GATEWAY_EXTRA_NAMES.split(',').map((s) => s.trim()).filter(Boolean)])],
      certificateDays: e.AGENT_CERT_DAYS,
      enrollPerMinute: e.AGENT_ENROLL_RATE_PER_MINUTE,
    },
  };
}
