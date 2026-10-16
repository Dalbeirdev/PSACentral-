import { Inject, Injectable } from '@nestjs/common';
import {
  type AuthStepResponse,
  type LoginRequest,
  type MeResponse,
  type MfaEnrollConfirmResponse,
  type MfaEnrollStartResponse,
  passwordPolicyViolations,
  type ProfileUpdate,
  SESSION_STATE_ROUTES,
  type SessionState,
} from '@psacc/contracts';
import QRCode from 'qrcode';
import type { AuthContext, RequestMeta, TenantContext } from '../../common/auth-context.js';
import { SecretBox } from '../../common/crypto.js';
import { AppError } from '../../common/problem.filter.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password.js';
import { SessionService } from './session.service.js';
import {
  base32Decode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp.js';

const INVALID_CREDENTIALS = 'Invalid email or password.';
const MAX_MFA_ATTEMPTS = 5;
const ISSUER = 'PSA Control Center';

interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: string;
  must_change_password: boolean;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  mfa_pending_secret_enc: string | null;
  mfa_last_used_step: number | null;
  failed_login_count: number;
  locked_until: Date | null;
  timezone: string;
  last_login_at: Date | null;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  absoluteExpiresAt: Date;
  step: AuthStepResponse;
}

@Injectable()
export class AuthService {
  private readonly box: SecretBox;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.box = new SecretBox(config.secrets.dataEncryptionKey);
  }

  /** Next required step of the sign-in sequence for this user. */
  requiredState(user: Pick<UserRow, 'mfa_enabled' | 'must_change_password'>, mfaVerified: boolean): SessionState {
    if (user.mfa_enabled && !mfaVerified) return 'mfa_pending';
    if (user.must_change_password) return 'password_change_required';
    if (this.config.auth.mfaRequired && !user.mfa_enabled) return 'mfa_setup_required';
    return 'active';
  }

  private step(state: SessionState): AuthStepResponse {
    return { state, redirectTo: SESSION_STATE_ROUTES[state] };
  }

  private loadUser(q: Queryable, userId: string): Promise<UserRow> {
    return q.one<UserRow>(
      `SELECT id, organization_id, email, display_name, password_hash, status, must_change_password, mfa_enabled,
              mfa_secret_enc, mfa_pending_secret_enc, mfa_last_used_step, failed_login_count, locked_until,
              timezone, last_login_at
       FROM users WHERE id = $1`,
      [userId],
    );
  }

  async login(dto: LoginRequest, meta: RequestMeta): Promise<IssuedSession> {
    const found = await this.db.unscoped((q) =>
      q.maybeOne<{ user_id: string; organization_id: string; password_hash: string | null; auth_provider: string }>(
        'SELECT * FROM auth_lookup_user($1)',
        [dto.email],
      ),
    );
    if (!found || found.auth_provider !== 'local' || !found.password_hash) {
      await burnPasswordCheck(dto.password);
      throw new AppError(401, 'invalid-credentials', INVALID_CREDENTIALS);
    }

    const ctx: TenantContext = { orgId: found.organization_id, userId: found.user_id, scopeAll: false };
    const passwordOk = await verifyPassword(dto.password, found.password_hash);

    const outcome = await this.db.tenant(ctx, async (q) => {
      // Lock the row so concurrent attempts cannot bypass the failure counter.
      const user = await q.one<UserRow & { org_status: string }>(
        `SELECT u.*, o.status AS org_status FROM users u JOIN organizations o ON o.id = u.organization_id
         WHERE u.id = $1 FOR UPDATE OF u`,
        [found.user_id],
      );
      const actor = { actorUserId: user.id, actorDisplay: user.email, meta, targetType: 'user', targetId: user.id, targetDisplay: user.email };

      const denial = (reason: string, action = 'auth.login.failed') =>
        this.audit.write(q, { orgId: user.organization_id, action, outcome: 'failure', ...actor, metadata: { reason } });

      if (user.org_status !== 'active') {
        await denial('organization_suspended');
        return { ok: false as const };
      }
      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        await denial('account_locked');
        return { ok: false as const };
      }
      if (!passwordOk) {
        const failures = user.failed_login_count + 1;
        const lock = failures >= this.config.auth.loginMaxFailures;
        await q.query(
          `UPDATE users SET failed_login_count = $2,
             locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
           WHERE id = $1`,
          [user.id, lock ? 0 : failures, lock, this.config.auth.loginLockMinutes],
        );
        await denial('bad_password');
        if (lock) {
          await this.audit.write(q, {
            orgId: user.organization_id,
            action: 'auth.login.locked',
            outcome: 'failure',
            ...actor,
            metadata: { failures, lockMinutes: this.config.auth.loginLockMinutes },
          });
        }
        return { ok: false as const };
      }
      if (user.status !== 'active') {
        await denial('account_disabled');
        return { ok: false as const };
      }

      await q.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
      const state = this.requiredState(user, false);
      const absolute = new Date(Date.now() + this.config.auth.sessionAbsoluteHours * 3_600_000);
      const session = await this.sessions.create(q, {
        orgId: user.organization_id,
        userId: user.id,
        state,
        mfaVerified: false,
        meta,
        absoluteExpiresAt: absolute,
      });
      await this.audit.write(q, {
        orgId: user.organization_id,
        action: 'auth.login.succeeded',
        outcome: 'success',
        ...actor,
        metadata: { nextState: state, sessionId: session.sessionId },
      });
      return { ok: true as const, ...session, absoluteExpiresAt: absolute, state };
    });

    if (!outcome.ok) throw new AppError(401, 'invalid-credentials', INVALID_CREDENTIALS);
    return { token: outcome.token, sessionId: outcome.sessionId, absoluteExpiresAt: outcome.absoluteExpiresAt, step: this.step(outcome.state) };
  }

  /** Replaces the session with a fresh token (prevents fixation) when the sign-in state advances. */
  private async rotate(q: Queryable, auth: AuthContext, state: SessionState, mfaVerified: boolean, meta: RequestMeta): Promise<IssuedSession> {
    const current = await q.one<{ absolute_expires_at: Date }>('SELECT absolute_expires_at FROM sessions WHERE id = $1', [auth.sessionId]);
    await this.sessions.revoke(q, auth.sessionId, 'rotated');
    const s = await this.sessions.create(q, {
      orgId: auth.orgId,
      userId: auth.userId,
      state,
      mfaVerified,
      meta,
      absoluteExpiresAt: current.absolute_expires_at,
    });
    return { ...s, absoluteExpiresAt: current.absolute_expires_at, step: this.step(state) };
  }

  async verifyMfa(auth: AuthContext, code: string, meta: RequestMeta): Promise<IssuedSession> {
    const result = await this.db.tenant(auth, async (q) => {
      const user = await this.loadUser(q, auth.userId);
      const session = await q.one<{ mfa_failed_attempts: number }>('SELECT mfa_failed_attempts FROM sessions WHERE id = $1 FOR UPDATE', [auth.sessionId]);
      const actor = { orgId: auth.orgId, actorUserId: user.id, actorDisplay: user.email, meta, targetType: 'user', targetId: user.id };
      if (!user.mfa_enabled || !user.mfa_secret_enc) throw new AppError(409, 'mfa-not-enabled', 'MFA is not enabled for this account.');

      let method: 'totp' | 'recovery_code' | null = null;
      if (/^\d{6}$/.test(code)) {
        const secret = base32Decode(this.box.open(user.mfa_secret_enc, `mfa:${user.id}`));
        const stepNo = verifyTotp(secret, code, Date.now());
        if (stepNo !== null && (user.mfa_last_used_step === null || stepNo > user.mfa_last_used_step)) {
          await q.query('UPDATE users SET mfa_last_used_step = $2 WHERE id = $1', [user.id, stepNo]);
          method = 'totp';
        }
      } else {
        const used = await q.query(
          `UPDATE user_recovery_codes SET used_at = now()
           WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
          [user.id, hashRecoveryCode(code)],
        );
        if (used.length === 1) method = 'recovery_code';
      }

      if (!method) {
        const attempts = session.mfa_failed_attempts + 1;
        await q.query('UPDATE sessions SET mfa_failed_attempts = $2 WHERE id = $1', [auth.sessionId, attempts]);
        await this.audit.write(q, { ...actor, action: 'auth.mfa.failed', outcome: 'failure', metadata: { attempts } });
        if (attempts >= MAX_MFA_ATTEMPTS) {
          await this.sessions.revoke(q, auth.sessionId, 'mfa_attempts_exceeded');
          await this.audit.write(q, { ...actor, action: 'auth.session.revoked', outcome: 'success', metadata: { reason: 'mfa_attempts_exceeded' } });
          return { ok: false as const, revoked: true };
        }
        return { ok: false as const, revoked: false };
      }

      await this.audit.write(q, { ...actor, action: 'auth.mfa.verified', outcome: 'success', metadata: { method } });
      return { ok: true as const, issued: await this.rotate(q, auth, this.requiredState(user, true), true, meta) };
    });
    if (!result.ok) {
      throw result.revoked
        ? new AppError(401, 'mfa-locked', 'Too many incorrect codes. Sign in again.')
        : new AppError(400, 'mfa-invalid', 'That code is not valid. Try the current code from your authenticator app.');
    }
    return result.issued;
  }

  async changePassword(auth: AuthContext, currentPassword: string, newPassword: string, meta: RequestMeta): Promise<IssuedSession | null> {
    const user = await this.db.tenant(auth, (q) => this.loadUser(q, auth.userId));
    const violations = passwordPolicyViolations(newPassword, user.email);
    if (violations.length) throw new AppError(422, 'password-policy', violations.join(' '));
    if (!user.password_hash || !(await verifyPassword(currentPassword, user.password_hash))) {
      await this.audit.record(auth, {
        action: 'auth.password.change_failed', outcome: 'failure', actorUserId: user.id, actorDisplay: user.email, meta,
        targetType: 'user', targetId: user.id, metadata: { reason: 'bad_current_password' },
      });
      throw new AppError(400, 'invalid-current-password', 'The current password is incorrect.');
    }
    const hash = await hashPassword(newPassword);
    return this.db.tenant(auth, async (q) => {
      await q.query('UPDATE users SET password_hash = $2, password_changed_at = now(), must_change_password = false WHERE id = $1', [user.id, hash]);
      const revoked = await this.sessions.revokeAllForUser(q, user.id, 'password_changed', auth.sessionId);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'auth.password.changed', outcome: 'success', actorUserId: user.id, actorDisplay: user.email,
        meta, targetType: 'user', targetId: user.id, metadata: { otherSessionsRevoked: revoked },
      });
      const next = this.requiredState({ ...user, must_change_password: false }, auth.mfaVerified);
      return next !== auth.sessionState ? this.rotate(q, auth, next, auth.mfaVerified, meta) : null;
    });
  }

  async startMfaEnrollment(auth: AuthContext, meta: RequestMeta): Promise<MfaEnrollStartResponse> {
    return this.db.tenant(auth, async (q) => {
      const user = await this.loadUser(q, auth.userId);
      if (user.mfa_enabled) throw new AppError(409, 'mfa-already-enabled', 'MFA is already enabled. Disable it first to re-enroll.');
      const secret = generateTotpSecret();
      await q.query('UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1', [user.id, this.box.seal(secret, `mfa-pending:${user.id}`)]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'auth.mfa.enrollment_started', outcome: 'success', actorUserId: user.id,
        actorDisplay: user.email, meta, targetType: 'user', targetId: user.id,
      });
      const uri = otpauthUri(secret, user.email, ISSUER);
      const qrSvg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#0F172A', light: '#FFFFFF' } });
      return { secret, otpauthUri: uri, qrSvg };
    });
  }

  async confirmMfaEnrollment(auth: AuthContext, code: string, meta: RequestMeta): Promise<{ response: MfaEnrollConfirmResponse; issued: IssuedSession }> {
    const result = await this.db.tenant(auth, async (q) => {
      const user = await this.loadUser(q, auth.userId);
      if (user.mfa_enabled) throw new AppError(409, 'mfa-already-enabled', 'MFA is already enabled.');
      if (!user.mfa_pending_secret_enc) throw new AppError(409, 'mfa-enrollment-not-started', 'Start MFA enrollment first.');
      const secretB32 = this.box.open(user.mfa_pending_secret_enc, `mfa-pending:${user.id}`);
      const stepNo = verifyTotp(base32Decode(secretB32), code, Date.now());
      if (stepNo === null) {
        // Committed (not thrown) so the failed attempt stays in the audit trail.
        await this.audit.write(q, {
          orgId: auth.orgId, action: 'auth.mfa.enrollment_failed', outcome: 'failure', actorUserId: user.id,
          actorDisplay: user.email, meta, targetType: 'user', targetId: user.id,
        });
        return null;
      }
      await q.query(
        `UPDATE users SET mfa_enabled = true, mfa_secret_enc = $2, mfa_pending_secret_enc = NULL,
           mfa_last_used_step = $3, mfa_enrolled_at = now() WHERE id = $1`,
        [user.id, this.box.seal(secretB32, `mfa:${user.id}`), stepNo],
      );
      const codes = generateRecoveryCodes(10);
      await q.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [user.id]);
      await q.query(
        `INSERT INTO user_recovery_codes (organization_id, user_id, code_hash) SELECT $1, $2, unnest($3::bytea[])`,
        [auth.orgId, user.id, codes.map(hashRecoveryCode)],
      );
      const revoked = await this.sessions.revokeAllForUser(q, user.id, 'mfa_enrolled', auth.sessionId);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'auth.mfa.enrolled', outcome: 'success', actorUserId: user.id, actorDisplay: user.email,
        meta, targetType: 'user', targetId: user.id, metadata: { recoveryCodesIssued: codes.length, otherSessionsRevoked: revoked },
      });
      const next = this.requiredState({ ...user, mfa_enabled: true }, true);
      const issued = await this.rotate(q, auth, next, true, meta);
      return { response: { recoveryCodes: codes, ...issued.step }, issued };
    });
    if (!result) throw new AppError(400, 'mfa-invalid', 'That code is not valid. Check the time on your device and try again.');
    return result;
  }

  async disableMfa(auth: AuthContext, password: string, code: string, meta: RequestMeta): Promise<void> {
    if (this.config.auth.mfaRequired) throw new AppError(409, 'mfa-required', 'MFA is required by policy and cannot be disabled.');
    const user = await this.db.tenant(auth, (q) => this.loadUser(q, auth.userId));
    if (!user.mfa_enabled || !user.mfa_secret_enc) throw new AppError(409, 'mfa-not-enabled', 'MFA is not enabled.');
    const pwOk = !!user.password_hash && (await verifyPassword(password, user.password_hash));
    const stepNo = verifyTotp(base32Decode(this.box.open(user.mfa_secret_enc, `mfa:${user.id}`)), code, Date.now());
    if (!pwOk || stepNo === null) {
      await this.audit.record(auth, {
        action: 'auth.mfa.disable_failed', outcome: 'failure', actorUserId: user.id, actorDisplay: user.email, meta,
        targetType: 'user', targetId: user.id,
      });
      throw new AppError(400, 'mfa-disable-denied', 'Password or code is incorrect.');
    }
    await this.db.tenant(auth, async (q) => {
      await q.query(
        `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL,
           mfa_last_used_step = NULL, mfa_enrolled_at = NULL WHERE id = $1`,
        [user.id],
      );
      await q.query('DELETE FROM user_recovery_codes WHERE user_id = $1', [user.id]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'auth.mfa.disabled', outcome: 'success', actorUserId: user.id, actorDisplay: user.email,
        meta, targetType: 'user', targetId: user.id,
      });
    });
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth, async (q) => {
      await this.sessions.revoke(q, auth.sessionId, 'logout');
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'auth.logout', outcome: 'success', actorUserId: auth.userId,
        actorDisplay: await this.emailOf(q, auth.userId), meta, targetType: 'session', targetId: auth.sessionId,
      });
    });
  }

  async updateProfile(auth: AuthContext, dto: ProfileUpdate, meta: RequestMeta): Promise<void> {
    if (!isValidTimeZone(dto.timezone)) throw new AppError(422, 'invalid-timezone', 'Choose a valid IANA time zone.');
    await this.db.tenant(auth, async (q) => {
      await q.query('UPDATE users SET display_name = $2, timezone = $3 WHERE id = $1', [auth.userId, dto.displayName, dto.timezone]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'user.profile.updated', outcome: 'success', actorUserId: auth.userId,
        actorDisplay: await this.emailOf(q, auth.userId), meta, targetType: 'user', targetId: auth.userId,
        metadata: { fields: ['displayName', 'timezone'] },
      });
    });
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    return this.db.tenant(auth, async (q) => {
      const user = await this.loadUser(q, auth.userId);
      const org = await q.one<{ id: string; name: string; slug: string }>('SELECT id, name, slug FROM organizations WHERE id = $1', [auth.orgId]);
      const session = await q.one<{ idle_expires_at: Date; absolute_expires_at: Date }>(
        'SELECT idle_expires_at, absolute_expires_at FROM sessions WHERE id = $1',
        [auth.sessionId],
      );
      return {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          timezone: user.timezone,
          mfaEnabled: user.mfa_enabled,
          lastLoginAt: user.last_login_at?.toISOString() ?? null,
        },
        organization: org,
        session: {
          state: auth.sessionState,
          idleExpiresAt: session.idle_expires_at.toISOString(),
          absoluteExpiresAt: session.absolute_expires_at.toISOString(),
        },
        roles: auth.roles,
        permissions: [...auth.permissions].sort(),
        clientScope: auth.scopeAll ? 'all_clients' : 'assigned_clients',
        flags: { mustChangePassword: user.must_change_password, mfaRequired: this.config.auth.mfaRequired },
      };
    });
  }

  private async emailOf(q: Queryable, userId: string): Promise<string> {
    const r = await q.maybeOne<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    return r?.email ?? 'unknown';
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
