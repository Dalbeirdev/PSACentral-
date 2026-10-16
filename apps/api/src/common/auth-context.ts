import type { PermissionKey, SessionState } from '@psacc/contracts';
import type { Request } from 'express';

export interface AuthContext {
  userId: string;
  orgId: string;
  sessionId: string;
  sessionState: SessionState;
  mfaVerified: boolean;
  roles: { key: string; name: string }[];
  permissions: ReadonlySet<PermissionKey>;
  scopeAll: boolean;
}

/** Minimal context for database work done before/without a full session (login, system jobs). */
export interface TenantContext {
  orgId: string;
  userId?: string | null;
  scopeAll: boolean;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export type AppRequest = Request & {
  requestId: string;
  auth?: AuthContext;
};

export function requestMeta(req: AppRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
    requestId: req.requestId,
  };
}
