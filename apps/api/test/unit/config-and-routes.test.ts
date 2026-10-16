import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { CONTROLLERS } from '../../src/app.module.js';
import { AUTHENTICATED_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../../src/common/decorators.js';
import { loadConfig } from '../../src/config/env.js';
import { buildDays } from '../../src/modules/dashboard/dashboard.service.js';

const base = {
  APP_ENV: 'development',
  APP_ALLOWED_ORIGINS: 'http://localhost:3210',
  CSRF_SECRET: Buffer.alloc(32, 1).toString('base64'),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
  DATABASE_URL: 'postgres://psacc_app:x@127.0.0.1:5432/psacc_dev',
};

describe('environment configuration', () => {
  it('loads development defaults with insecure-transport cookie names', () => {
    const c = loadConfig({ ...base });
    expect(c.env).toBe('development');
    expect(c.auth.secureCookies).toBe(false);
    expect(c.auth.sessionCookieName).toBe('psacc_session');
    expect(c.auth.mfaRequired).toBe(true); // secure default when unset
  });

  const prodEdge = { EDGE_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`, AGENT_GATEWAY_URL: 'https://agents.cp.example.com' };

  it('uses __Host- cookies and Secure in production', () => {
    const c = loadConfig({ ...base, ...prodEdge, APP_ENV: 'production', APP_ALLOWED_ORIGINS: 'https://cp.example.com', AUTH_MFA_REQUIRED: 'true' });
    expect(c.auth.secureCookies).toBe(true);
    expect(c.auth.sessionCookieName).toBe('__Host-psacc_session');
  });

  it.each([
    [{ AUTH_MFA_REQUIRED: 'false', APP_ALLOWED_ORIGINS: 'https://cp.example.com' }, /AUTH_MFA_REQUIRED/],
    [{ APP_ALLOWED_ORIGINS: 'http://cp.example.com' }, /https/],
    [{ APP_ALLOWED_ORIGINS: 'https://cp.example.com', DATABASE_URL: 'postgres://postgres:x@db/psacc' }, /superuser or schema owner/],
    [{ APP_ALLOWED_ORIGINS: 'https://cp.example.com', DATABASE_URL: 'postgres://psacc_owner:x@db/psacc' }, /superuser or schema owner/],
    [{ APP_ALLOWED_ORIGINS: 'https://cp.example.com', AGENT_GATEWAY_URL: 'https://agents.cp.example.com' }, /EDGE_IMAGE_DIGEST/],
    [{ APP_ALLOWED_ORIGINS: 'https://cp.example.com', EDGE_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}` }, /AGENT_GATEWAY_URL/],
    [{ AGENT_GATEWAY_URL: 'http://agents.cp.example.com' }, /https/],
  ])('refuses unsafe production configuration %#', (overrides, message) => {
    expect(() => loadConfig({ ...base, APP_ENV: 'production', ...overrides })).toThrow(message);
  });

  it('rejects weak or malformed secrets', () => {
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/DATA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...base, CSRF_SECRET: 'short' })).toThrow(/CSRF_SECRET/);
    expect(() => loadConfig({ ...base, APP_ENV: 'qa' })).toThrow(/APP_ENV/);
  });
});

describe('authorization declarations (default deny)', () => {
  it('every route declares @Public, @AuthenticatedOnly or @RequirePermissions', () => {
    const undeclared: string[] = [];
    let routes = 0;
    for (const ctrl of CONTROLLERS) {
      const proto = ctrl.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue; // not a route
        routes++;
        const declared = [IS_PUBLIC, AUTHENTICATED_ONLY, REQUIRED_PERMISSIONS].some(
          (k) => Reflect.getMetadata(k, handler) !== undefined || Reflect.getMetadata(k, ctrl) !== undefined,
        );
        if (!declared) undeclared.push(`${ctrl.name}.${name} (${String(Reflect.getMetadata(PATH_METADATA, handler))})`);
      }
    }
    expect(routes).toBeGreaterThan(15);
    expect(undeclared).toEqual([]);
  });

  it('only health, system info and login are public', () => {
    const publicRoutes: string[] = [];
    for (const ctrl of CONTROLLERS) {
      const proto = ctrl.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (typeof handler === 'function' && Reflect.getMetadata(IS_PUBLIC, handler)) publicRoutes.push(`${ctrl.name}.${name}`);
      }
    }
    expect(publicRoutes.sort()).toEqual(['AuthController.login', 'SystemController.info', 'SystemController.live', 'SystemController.ready']);
  });
});

describe('dashboard timeline pivot', () => {
  it('zero-fills missing states and keeps empty days', () => {
    const days = buildDays([
      { day: '2026-10-01', state: 'healthy', count: 3 },
      { day: '2026-10-01', state: 'critical', count: 1 },
      { day: '2026-10-02', state: null, count: 0 },
    ]);
    expect(days).toEqual([
      { date: '2026-10-01', healthy: 3, degraded: 0, critical: 1, offline: 0, unknown: 0 },
      { date: '2026-10-02', healthy: 0, degraded: 0, critical: 0, offline: 0, unknown: 0 },
    ]);
  });
});
