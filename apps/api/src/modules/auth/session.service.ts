import { Inject, Injectable } from '@nestjs/common';
import type { PermissionKey, SessionState } from '@psacc/contracts';
import type { Response } from 'express';
import type { AuthContext, RequestMeta, TenantContext } from '../../common/auth-context.js';
import { hmacSha256, randomToken, sha256 } from '../../common/crypto.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';

export interface ResolvedSession {
  sessionId: string;
  orgId: string;
  userId: string;
  state: SessionState;
  mfaVerifiedAt: Date | null;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

const TOUCH_INTERVAL_MS = 60_000;

/** Opaque server-side sessions: the cookie holds 256 random bits; only SHA-256(token) is stored. */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    q: Queryable,
    p: { orgId: string; userId: string; state: SessionState; mfaVerified: boolean; meta: RequestMeta; absoluteExpiresAt?: Date },
  ): Promise<{ token: string; sessionId: string }> {
    const token = randomToken(32);
    const now = Date.now();
    const absolute = p.absoluteExpiresAt ?? new Date(now + this.config.auth.sessionAbsoluteHours * 3_600_000);
    const idle = new Date(Math.min(now + this.config.auth.sessionIdleMinutes * 60_000, absolute.getTime()));
    const row = await q.one<{ id: string }>(
      `INSERT INTO sessions (organization_id, user_id, token_hash, state, mfa_verified_at, idle_expires_at, absolute_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [p.orgId, p.userId, sha256(token), p.state, p.mfaVerified ? new Date() : null, idle, absolute, p.meta.ip, p.meta.userAgent],
    );
    return { token, sessionId: row.id };
  }

  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = await this.db.unscoped((q) =>
      q.maybeOne<Record<string, unknown>>('SELECT * FROM auth_resolve_session($1)', [sha256(token)]),
    );
    if (!row) return null;
    return {
      sessionId: row.session_id as string,
      orgId: row.organization_id as string,
      userId: row.user_id as string,
      state: row.state as SessionState,
      mfaVerifiedAt: (row.mfa_verified_at as Date | null) ?? null,
      lastSeenAt: row.last_seen_at as Date,
      idleExpiresAt: row.idle_expires_at as Date,
      absoluteExpiresAt: row.absolute_expires_at as Date,
    };
  }

  /** Loads roles, effective permissions and client scope; slides the idle timeout (throttled). */
  async loadAuthContext(s: ResolvedSession): Promise<AuthContext> {
    const ctx: TenantContext = { orgId: s.orgId, userId: s.userId, scopeAll: false };
    return this.db.tenant(ctx, async (q) => {
      const roles = await q.query<{ key: string; name: string; scope: string; perms: string[] }>(
        `SELECT r.key, r.name, r.scope,
                coalesce(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS perms
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         WHERE ur.user_id = $1
         GROUP BY r.id
         ORDER BY r.name`,
        [s.userId],
      );
      if (Date.now() - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await q.query(
          `UPDATE sessions SET last_seen_at = now(),
             idle_expires_at = least(now() + make_interval(mins => $2), absolute_expires_at)
           WHERE id = $1`,
          [s.sessionId, this.config.auth.sessionIdleMinutes],
        );
      }
      return {
        userId: s.userId,
        orgId: s.orgId,
        sessionId: s.sessionId,
        sessionState: s.state,
        mfaVerified: s.mfaVerifiedAt !== null,
        roles: roles.map((r) => ({ key: r.key, name: r.name })),
        permissions: new Set(roles.flatMap((r) => r.perms) as PermissionKey[]),
        scopeAll: roles.some((r) => r.scope === 'all_clients'),
      };
    });
  }

  async revoke(q: Queryable, sessionId: string, reason: string): Promise<void> {
    await q.query('UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason]);
  }

  async revokeAllForUser(q: Queryable, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const rows = await q.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
       WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid) RETURNING id`,
      [userId, reason, exceptSessionId ?? null],
    );
    return rows.length;
  }

  csrfTokenFor(sessionId: string): string {
    return hmacSha256(this.config.secrets.csrfSecret, `csrf:${sessionId}`).toString('base64url');
  }

  setCookies(res: Response, token: string, sessionId: string, absoluteExpiresAt: Date) {
    const common = { path: '/', secure: this.config.auth.secureCookies, sameSite: 'lax' as const, expires: absoluteExpiresAt };
    res.cookie(this.config.auth.sessionCookieName, token, { ...common, httpOnly: true });
    // Readable by the UI so it can echo it in the x-csrf-token header (double-submit, HMAC-bound).
    res.cookie(this.config.auth.csrfCookieName, this.csrfTokenFor(sessionId), { ...common, httpOnly: false });
  }

  clearCookies(res: Response) {
    const common = { path: '/', secure: this.config.auth.secureCookies, sameSite: 'lax' as const };
    res.clearCookie(this.config.auth.sessionCookieName, common);
    res.clearCookie(this.config.auth.csrfCookieName, common);
  }
}
