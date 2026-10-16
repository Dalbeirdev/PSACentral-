import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { PermissionKey, SessionState } from '@psacc/contracts';
import { type AppRequest, requestMeta } from '../../common/auth-context.js';
import { safeEqual } from '../../common/crypto.js';
import {
  ALLOWED_SESSION_STATES,
  AUTHENTICATED_ONLY,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
} from '../../common/decorators.js';
import { AppError } from '../../common/problem.filter.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function meta<T>(reflector: Reflector, key: string, ctx: ExecutionContext): T | undefined {
  return reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
}

/** Resolves the session cookie. Default-deny: every non-@Public route needs a valid session. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (meta<boolean>(this.reflector, IS_PUBLIC, ctx)) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[this.config.auth.sessionCookieName];
    if (!token) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    const session = await this.sessions.resolve(token);
    if (!session) throw new AppError(401, 'session-expired', 'Your session has expired. Sign in again.');

    const allowed = meta<SessionState[]>(this.reflector, ALLOWED_SESSION_STATES, ctx) ?? [];
    if (session.state !== 'active' && !allowed.includes(session.state)) {
      throw new AppError(403, 'sign-in-incomplete', `Complete sign-in first (${session.state}).`);
    }
    req.auth = await this.sessions.loadAuthContext(session);
    return true;
  }
}

/** HMAC-bound double-submit CSRF token + Origin allow-list on unsafe methods. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    if (SAFE_METHODS.has(req.method)) return true;

    // Origin check applies to every unsafe request, including public ones such as login.
    const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
    if (origin && !this.config.allowedOrigins.includes(origin)) {
      throw new AppError(403, 'csrf-origin', 'Request origin is not allowed.');
    }
    if (meta<boolean>(this.reflector, IS_PUBLIC, ctx)) return true;
    if (!origin && this.config.auth.secureCookies) throw new AppError(403, 'csrf-origin', 'Missing request origin.');

    const header = req.headers['x-csrf-token'];
    const expected = req.auth ? this.sessions.csrfTokenFor(req.auth.sessionId) : null;
    if (!expected || typeof header !== 'string' || !safeEqual(header, expected)) {
      throw new AppError(403, 'csrf-token', 'Security token missing or invalid. Reload the page and try again.');
    }
    return true;
  }
}

/**
 * Per-IP rate limiting. Subclassed only to declare constructor injection explicitly
 * (the codebase does not rely on emitted decorator metadata).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * Server-enforced authorization. A route must declare @Public, @AuthenticatedOnly or
 * @RequirePermissions; anything undeclared is denied. Denials are audited.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (meta<boolean>(this.reflector, IS_PUBLIC, ctx)) return true;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const auth = req.auth;
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    if (meta<boolean>(this.reflector, AUTHENTICATED_ONLY, ctx)) return true;

    const required = meta<PermissionKey[]>(this.reflector, REQUIRED_PERMISSIONS, ctx);
    const missing = required ? required.filter((p) => !auth.permissions.has(p)) : ['(route has no permission declaration)'];
    if (missing.length === 0) return true;

    await this.audit.record(auth, {
      action: 'access.denied',
      outcome: 'denied',
      actorUserId: auth.userId,
      actorDisplay: auth.userId,
      meta: requestMeta(req),
      targetType: 'route',
      targetId: `${req.method} ${req.route?.path ?? req.path}`.slice(0, 128),
      metadata: { missingPermissions: missing },
    });
    throw new AppError(403, 'forbidden', 'You do not have permission to perform this action.');
  }
}
