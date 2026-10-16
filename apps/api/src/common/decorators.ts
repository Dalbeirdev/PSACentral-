import { createParamDecorator, type ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { PermissionKey, SessionState } from '@psacc/contracts';
import type { AppRequest, AuthContext } from './auth-context.js';

export const IS_PUBLIC = 'psacc:public';
export const AUTHENTICATED_ONLY = 'psacc:authenticated-only';
export const REQUIRED_PERMISSIONS = 'psacc:permissions';
export const ALLOWED_SESSION_STATES = 'psacc:session-states';

/** No session required. Use sparingly: login, health, public system info. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Any signed-in user (no specific permission), e.g. own profile. */
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY, true);

/** Requires ALL listed permissions. */
export const RequirePermissions = (...permissions: PermissionKey[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Session states (besides `active`) allowed to reach the route. */
export const AllowSessionStates = (...states: SessionState[]) => SetMetadata(ALLOWED_SESSION_STATES, states);

export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.auth) throw new UnauthorizedException();
  return req.auth;
});

export const CurrentRequest = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AppRequest => ctx.switchToHttp().getRequest<AppRequest>(),
);
