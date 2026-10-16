import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totp } from '../../src/modules/auth/totp.js';
import { Client, EMAIL, ORIGIN, PASSWORD, asApp, ids, ownerQuery, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await app.close();
});

describe('public endpoints', () => {
  it('liveness and readiness report a migrated, reachable database', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/health/live')).body).toEqual({ status: 'ok' });
    const ready = await request(app.getHttpServer()).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toMatchObject({ database: { status: 'up' }, migrations: { status: 'current', pending: 0 } });
  });

  it('system info exposes only non-sensitive fields', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/system/info');
    expect(Object.keys(r.body).sort()).toEqual(['environment', 'mfaRequired', 'name', 'version']);
    expect(r.body.environment).toBe('test');
  });

  it('sets security headers and no-store on API responses', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/system/info');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('sign-in', () => {
  it('rejects requests without a session (default deny) with problem+json', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/dashboard/summary');
    expect(r.status).toBe(401);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.body).toMatchObject({ type: 'urn:psacc:problem:unauthenticated', status: 401 });
    expect(r.body.requestId).toBeTruthy();
  });

  it('returns the same generic error for a wrong password and an unknown account', async () => {
    const c = new Client(app);
    const wrong = await c.login(EMAIL.viewer, 'definitely-not-the-password');
    const unknown = await c.login('nobody@psacc.test', 'definitely-not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.detail).toBe('Invalid email or password.');
    expect(unknown.body.detail).toBe(wrong.body.detail);
    expect(c.cookies.size).toBe(0);
  });

  it('validates input and rejects unknown fields', async () => {
    const c = new Client(app);
    const r = await c.post('/auth/login', { email: 'not-an-email', password: 'x', role: 'super_admin' });
    expect(r.status).toBe(400);
    expect(r.body.type).toBe('urn:psacc:problem:validation');
    expect(r.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(['email']));
  });

  it('issues an HttpOnly SameSite session cookie and a readable CSRF cookie; stores only the token hash', async () => {
    const c = new Client(app);
    const r = await c.login(EMAIL.viewer);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ state: 'active', redirectTo: '/dashboard' });
    const set = (r.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(set).toMatch(/psacc_session=[\w-]{43}; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Lax/);
    expect(set).toMatch(/psacc_csrf=[\w-]+; Path=\/; Expires=[^;]+; SameSite=Lax/);
    expect(set).not.toMatch(/psacc_csrf=[^\n]*HttpOnly/);

    const token = c.cookies.get('psacc_session')!;
    const rows = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1`, [createHash('sha256').update(token).digest()]);
    expect(rows[0]!.n).toBe(1);
    const plain = await ownerQuery<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE encode(token_hash, 'escape') LIKE $1`, [`%${token}%`]);
    expect(plain[0]!.n).toBe(0);
  });

  it('/auth/me never leaks password hashes, MFA secrets or token hashes', async () => {
    const c = await signedIn(app, EMAIL.admin);
    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(EMAIL.admin);
    expect(me.body.permissions).toContain('users.manage');
    expect(me.body.clientScope).toBe('all_clients');
    expect(JSON.stringify(me.body)).not.toMatch(/scrypt\$|password_hash|mfa_secret|token_hash/);
  });

  it('logout revokes the session server-side', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const stolen = c.cookieHeader;
    expect((await c.post('/auth/logout')).status).toBe(204);
    const replay = await request(app.getHttpServer()).get('/api/v1/auth/me').set('cookie', stolen);
    expect(replay.status).toBe(401);
  });

  it('expired sessions are rejected', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const token = c.cookies.get('psacc_session')!;
    const { orgA } = await ids();
    await ownerQuery(
      `UPDATE sessions SET idle_expires_at = now() - interval '1 minute', absolute_expires_at = now() WHERE token_hash = $1 AND organization_id = $2`,
      [createHash('sha256').update(token).digest(), orgA],
    );
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('records successful and failed sign-ins in the audit trail', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const r = await admin.get('/audit-events?action=auth.login&pageSize=100');
    const actions = r.body.items.map((e: { action: string; outcome: string }) => `${e.action}:${e.outcome}`);
    expect(actions).toContain('auth.login.succeeded:success');
    expect(actions).toContain('auth.login.failed:failure');
  });
});

describe('account lockout', () => {
  it('locks after 5 failures, refuses even the correct password, and audits the lock', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const created = await admin.post('/users', { email: 'lockout.subject@psacc.test', displayName: 'Lockout Subject', roleKeys: ['read_only'], initialPassword: 'Initial-Password-123' });
    expect(created.status).toBe(201);
    const c = new Client(app);
    for (let i = 0; i < 5; i++) expect((await c.login('lockout.subject@psacc.test', 'wrong-password-123')).status).toBe(401);
    expect((await c.login('lockout.subject@psacc.test', 'Initial-Password-123')).status).toBe(401);
    const [row] = await ownerQuery<{ locked: boolean }>(`SELECT locked_until > now() AS locked FROM users WHERE email = 'lockout.subject@psacc.test'`);
    expect(row!.locked).toBe(true);
    const audit = await admin.get('/audit-events?action=auth.login.locked');
    expect(audit.body.items.some((e: { targetDisplay: string }) => e.targetDisplay === 'lockout.subject@psacc.test')).toBe(true);
    const user = await admin.get(`/users/${created.body.user.id}`);
    expect(user.body.status).toBe('locked');
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without the CSRF header', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const r = await c.post('/auth/logout', undefined, { csrf: null });
    expect(r.status).toBe(403);
    expect(r.body.type).toBe('urn:psacc:problem:csrf-token');
  });

  it('rejects a CSRF token from another session', async () => {
    const a = await signedIn(app, EMAIL.viewer);
    const b = await signedIn(app, EMAIL.auditor);
    const r = await a.post('/auth/logout', undefined, { csrf: b.cookies.get('psacc_csrf')! });
    expect(r.status).toBe(403);
  });

  it('rejects cross-origin requests, including login', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const r = await c.post('/auth/logout', undefined, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.type).toBe('urn:psacc:problem:csrf-origin');
    const login = await new Client(app, 'https://evil.example').login(EMAIL.viewer);
    expect(login.status).toBe(403);
  });
});

describe('rate limiting', () => {
  it('returns 429 after the per-IP login limit', async () => {
    const limited = await startApp({ LOGIN_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const c = new Client(limited);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await c.login('nobody@psacc.test', 'wrong-password-123')).status);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
      process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '1000';
    }
  });
});

describe('multi-factor authentication', () => {
  const email = 'mfa.subject@psacc.test';
  const password = 'Mfa-Subject-Password-1';
  let secret: Buffer;
  let recoveryCodes: string[];

  it('enrolls TOTP: wrong code is rejected (and audited), correct code enables MFA and rotates the session', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    expect((await admin.post('/users', { email, displayName: 'MFA Subject', roleKeys: ['read_only'], initialPassword: password })).status).toBe(201);
    // Admin-created users must change their password first.
    const c = await signedIn(app, email, password);
    expect((await c.get('/auth/me')).body.session.state).toBe('password_change_required');
    expect((await c.post('/auth/password', { currentPassword: password, newPassword: `${password}-changed` })).status).toBe(200);

    const start = await c.post('/auth/mfa/enroll/start');
    expect(start.status).toBe(200);
    expect(start.body.qrSvg).toContain('<svg');
    expect(start.body.otpauthUri).toContain('otpauth://totp/');
    secret = base32Decode(start.body.secret);

    const bad = await c.post('/auth/mfa/enroll/confirm', { code: '000000' });
    expect(bad.status).toBe(400);
    // audit_events is FORCE-RLS: read it the way the app does, inside the organization's context.
    const { orgA } = await ids();
    const failed = await asApp({ orgId: orgA, scopeAll: true }, async (q) =>
      (await q.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'auth.mfa.enrollment_failed' AND actor_display = $1`, [email])).rows[0].n as number,
    );
    expect(failed).toBe(1);

    const before = c.cookies.get('psacc_session');
    const ok = await c.post('/auth/mfa/enroll/confirm', { code: totp(secret, Date.now()) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    recoveryCodes = ok.body.recoveryCodes;
    expect(c.cookies.get('psacc_session')).not.toBe(before);
    const stale = await request(app.getHttpServer()).get('/api/v1/auth/me').set('cookie', `psacc_session=${before}`);
    expect(stale.status).toBe(401);

    const [row] = await ownerQuery<{ id: string; mfa_secret_enc: string }>(`SELECT id, mfa_secret_enc FROM users WHERE email = $1`, [email]);
    expect(row!.mfa_secret_enc).toMatch(/^v1\./);
    expect(row!.mfa_secret_enc).not.toContain(start.body.secret);
    const stored = await asApp({ orgId: orgA, scopeAll: true }, async (q) =>
      (await q.query(`SELECT encode(code_hash, 'hex') AS h FROM user_recovery_codes WHERE user_id = $1`, [row!.id])).rows.map((r) => r.h as string),
    );
    expect(stored).toHaveLength(10);
    for (const code of recoveryCodes) expect(stored.join()).not.toContain(Buffer.from(code).toString('hex'));
  });

  it('requires the second factor at sign-in; pending sessions cannot reach business endpoints', async () => {
    const c = new Client(app);
    const r = await c.login(email, `${password}-changed`);
    expect(r.body).toEqual({ state: 'mfa_pending', redirectTo: '/login/mfa' });
    const blocked = await c.get('/dashboard/summary');
    expect(blocked.status).toBe(403);
    expect(blocked.body.type).toBe('urn:psacc:problem:sign-in-incomplete');
    expect((await c.post('/auth/mfa/verify', { code: '123456' })).status).toBe(400);
  });

  it('rejects a replayed TOTP code', async () => {
    // Wait for a fresh time step so this code has never been accepted before.
    const stepMs = 30_000;
    const wait = stepMs - (Date.now() % stepMs) + 200;
    await new Promise((r) => setTimeout(r, wait));
    const code = totp(secret, Date.now());
    const first = new Client(app);
    await first.login(email, `${password}-changed`);
    expect((await first.post('/auth/mfa/verify', { code })).body.state).toBe('active');
    const second = new Client(app);
    await second.login(email, `${password}-changed`);
    expect((await second.post('/auth/mfa/verify', { code })).status).toBe(400);
  }, 45_000);

  it('accepts a recovery code exactly once', async () => {
    const a = new Client(app);
    await a.login(email, `${password}-changed`);
    expect((await a.post('/auth/mfa/verify', { code: recoveryCodes[0] })).body.state).toBe('active');
    const b = new Client(app);
    await b.login(email, `${password}-changed`);
    expect((await b.post('/auth/mfa/verify', { code: recoveryCodes[0] })).status).toBe(400);
  });

  it('revokes the pending session after 5 wrong codes', async () => {
    const c = new Client(app);
    await c.login(email, `${password}-changed`);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await c.post('/auth/mfa/verify', { code: '000001' })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 401]);
    expect((await c.get('/auth/me')).status).toBe(401);
  });
});

describe('forced password change & MFA-required policy', () => {
  it('admin-created users get a temporary password and must change it; weak passwords are refused', async () => {
    const admin = await signedIn(app, EMAIL.admin);
    const created = await admin.post('/users', { email: 'temp.pass@psacc.test', displayName: 'Temp Pass', roleKeys: ['auditor'] });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toMatch(/^[A-Za-z2-9-]{27}$/);
    const c = await signedIn(app, 'temp.pass@psacc.test', created.body.temporaryPassword);
    expect((await c.get('/auth/me')).body.session.state).toBe('password_change_required');
    expect((await c.get('/dashboard/summary')).status).toBe(403);
    const weak = await c.post('/auth/password', { currentPassword: created.body.temporaryPassword, newPassword: 'temp.pass-123456' });
    expect(weak.status).toBe(422);
    const ok = await c.post('/auth/password', { currentPassword: created.body.temporaryPassword, newPassword: 'A-much-better-passphrase-7' });
    expect(ok.body).toEqual({ state: 'active', redirectTo: '/dashboard' });
    expect((await c.get('/dashboard/summary')).status).toBe(200);
    // The temporary password no longer works.
    expect((await new Client(app).login('temp.pass@psacc.test', created.body.temporaryPassword)).status).toBe(401);
  });

  it('with AUTH_MFA_REQUIRED, users without MFA can only reach enrollment', async () => {
    const strict = await startApp({ AUTH_MFA_REQUIRED: 'true' });
    try {
      const c = new Client(strict);
      const r = await c.login(EMAIL.viewer);
      expect(r.body).toEqual({ state: 'mfa_setup_required', redirectTo: '/login/mfa-setup' });
      expect((await c.get('/dashboard/summary')).status).toBe(403);
      expect((await c.post('/auth/mfa/enroll/start')).status).toBe(200);
      expect((await c.post('/auth/mfa/disable', { password: PASSWORD(), code: '123456' })).status).toBe(403);
    } finally {
      await strict.close();
    }
  });

  it('rejects an invalid time zone on profile update', async () => {
    const c = await signedIn(app, EMAIL.viewer);
    const r = await c.patch('/auth/profile', { displayName: 'Quinn Harper', timezone: 'Mars/Olympus_Mons' });
    expect(r.status).toBe(422);
    expect((await c.patch('/auth/profile', { displayName: 'Quinn Harper', timezone: 'Australia/Sydney' })).status).toBe(204);
  });
});

void ORIGIN;
