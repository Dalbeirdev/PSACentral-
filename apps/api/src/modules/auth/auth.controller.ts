import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthStepResponse,
  loginRequestSchema,
  type MeResponse,
  type MfaEnrollConfirmResponse,
  type MfaEnrollStartResponse,
  mfaDisableSchema,
  mfaEnrollConfirmSchema,
  mfaVerifyRequestSchema,
  passwordChangeSchema,
  profileUpdateSchema,
  SESSION_STATE_ROUTES,
  SESSION_STATES,
} from '@psacc/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { AllowSessionStates, AuthenticatedOnly, CurrentAuth, CurrentRequest, Public } from '../../common/decorators.js';
import { ApiZodBody, ZodPipe } from '../../common/zod.js';
import { loginRateLimit } from '../../config/rate-limits.js';
import { AuthService, type IssuedSession } from './auth.service.js';
import { SessionService } from './session.service.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  private issue(res: Response, issued: IssuedSession): AuthStepResponse {
    this.sessions.setCookies(res, issued.token, issued.sessionId, issued.absoluteExpiresAt);
    return issued.step;
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle({ default: loginRateLimit })
  @ApiOperation({ summary: 'Sign in with email + password. Returns the next sign-in step.' })
  @ApiZodBody(loginRequestSchema)
  async login(
    @Body(new ZodPipe(loginRequestSchema)) dto: z.infer<typeof loginRequestSchema>,
    @CurrentRequest() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    return this.issue(res, await this.auth.login(dto, requestMeta(req)));
  }

  @Post('mfa/verify')
  @AuthenticatedOnly()
  @AllowSessionStates('mfa_pending')
  @HttpCode(200)
  @Throttle({ default: loginRateLimit })
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Complete sign-in with a TOTP or recovery code.' })
  @ApiZodBody(mfaVerifyRequestSchema)
  async verifyMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaVerifyRequestSchema)) dto: z.infer<typeof mfaVerifyRequestSchema>,
    @CurrentRequest() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    if (auth.sessionState !== 'mfa_pending') return { state: auth.sessionState, redirectTo: SESSION_STATE_ROUTES[auth.sessionState] };
    return this.issue(res, await this.auth.verifyMfa(auth, dto.code, requestMeta(req)));
  }

  @Post('password')
  @AuthenticatedOnly()
  @AllowSessionStates('password_change_required')
  @HttpCode(200)
  @Throttle({ default: loginRateLimit })
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Change own password. Revokes all other sessions.' })
  @ApiZodBody(passwordChangeSchema)
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(passwordChangeSchema)) dto: z.infer<typeof passwordChangeSchema>,
    @CurrentRequest() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthStepResponse> {
    const issued = await this.auth.changePassword(auth, dto.currentPassword, dto.newPassword, requestMeta(req));
    if (issued) return this.issue(res, issued);
    return { state: auth.sessionState, redirectTo: SESSION_STATE_ROUTES[auth.sessionState] };
  }

  @Post('mfa/enroll/start')
  @AuthenticatedOnly()
  @AllowSessionStates('mfa_setup_required')
  @HttpCode(200)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Begin TOTP enrollment. Returns the secret and a QR code (SVG).' })
  startEnrollment(@CurrentAuth() auth: AuthContext, @CurrentRequest() req: AppRequest): Promise<MfaEnrollStartResponse> {
    return this.auth.startMfaEnrollment(auth, requestMeta(req));
  }

  @Post('mfa/enroll/confirm')
  @AuthenticatedOnly()
  @AllowSessionStates('mfa_setup_required')
  @HttpCode(200)
  @Throttle({ default: loginRateLimit })
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Confirm TOTP enrollment. Returns one-time recovery codes.' })
  @ApiZodBody(mfaEnrollConfirmSchema)
  async confirmEnrollment(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaEnrollConfirmSchema)) dto: z.infer<typeof mfaEnrollConfirmSchema>,
    @CurrentRequest() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaEnrollConfirmResponse> {
    const { response, issued } = await this.auth.confirmMfaEnrollment(auth, dto.code, requestMeta(req));
    this.issue(res, issued);
    return response;
  }

  @Post('mfa/disable')
  @AuthenticatedOnly()
  @HttpCode(204)
  @Throttle({ default: loginRateLimit })
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Disable MFA (not allowed when MFA is required by policy).' })
  @ApiZodBody(mfaDisableSchema)
  async disableMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaDisableSchema)) dto: z.infer<typeof mfaDisableSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<void> {
    await this.auth.disableMfa(auth, dto.password, dto.code, requestMeta(req));
  }

  @Post('logout')
  @AuthenticatedOnly()
  @AllowSessionStates(...SESSION_STATES)
  @HttpCode(204)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Sign out and revoke the current session.' })
  async logout(
    @CurrentAuth() auth: AuthContext,
    @CurrentRequest() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth, requestMeta(req));
    this.sessions.clearCookies(res);
  }

  @Get('me')
  @AuthenticatedOnly()
  @AllowSessionStates(...SESSION_STATES)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Current user, organization, roles, effective permissions and session state.' })
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  @Patch('profile')
  @AuthenticatedOnly()
  @HttpCode(204)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Update own display name and preferred time zone.' })
  @ApiZodBody(profileUpdateSchema)
  async updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(profileUpdateSchema)) dto: z.infer<typeof profileUpdateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<void> {
    await this.auth.updateProfile(auth, dto, requestMeta(req));
  }
}
