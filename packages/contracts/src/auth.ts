import { z } from 'zod';
import type { ClientScope, PermissionKey } from './permissions.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Returns a list of policy violations (empty = acceptable). Shared by UI and API. */
export function passwordPolicyViolations(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character.');
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && password.toLowerCase().includes(local)) {
    problems.push('Do not include your email name in the password.');
  }
  return problems;
}

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email({ error: 'Enter a valid email address.' })).pipe(z.string().max(254));

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');

export const mfaVerifyRequestSchema = z.strictObject({
  code: z.string().trim().min(6).max(32),
});
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;

export const mfaEnrollConfirmSchema = z.strictObject({ code: totpCodeSchema });

export const mfaDisableSchema = z.strictObject({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: totpCodeSchema,
});

export const passwordChangeSchema = z
  .strictObject({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'The new password must differ from the current password.',
    path: ['newPassword'],
  });

export const profileUpdateSchema = z.strictObject({
  displayName: z.string().trim().min(2).max(120),
  timezone: z.string().trim().min(1).max(64),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/**
 * Session states, in the order a sign-in moves through them:
 * mfa_pending → password_change_required → mfa_setup_required → active.
 * Only `active` sessions can reach business endpoints.
 */
export const SESSION_STATES = ['mfa_pending', 'password_change_required', 'mfa_setup_required', 'active'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Where the UI should send the user next for a given session state. */
export const SESSION_STATE_ROUTES: Record<SessionState, string> = {
  mfa_pending: '/login/mfa',
  password_change_required: '/login/password',
  mfa_setup_required: '/login/mfa-setup',
  active: '/dashboard',
};

export interface AuthStepResponse {
  state: SessionState;
  redirectTo: string;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    timezone: string;
    mfaEnabled: boolean;
    lastLoginAt: string | null;
  };
  organization: { id: string; name: string; slug: string };
  session: { state: SessionState; idleExpiresAt: string; absoluteExpiresAt: string };
  roles: { key: string; name: string }[];
  permissions: PermissionKey[];
  clientScope: ClientScope;
  flags: { mustChangePassword: boolean; mfaRequired: boolean };
}

export interface MfaEnrollStartResponse {
  secret: string;
  otpauthUri: string;
  qrSvg: string;
}

export interface MfaEnrollConfirmResponse extends AuthStepResponse {
  recoveryCodes: string[];
}
