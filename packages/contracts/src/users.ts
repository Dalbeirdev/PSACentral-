import { z } from 'zod';
import { emailSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './auth.js';
import { listQuerySchema } from './common.js';
import type { ClientScope, PermissionKey } from './permissions.js';

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const roleKeysSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/))
  .min(1, 'Assign at least one role.')
  .max(8)
  .refine((v) => new Set(v).size === v.length, 'Roles must be unique.');

export const createUserSchema = z.strictObject({
  email: emailSchema,
  displayName: z.string().trim().min(2, 'Enter a name of at least 2 characters.').max(120),
  roleKeys: roleKeysSchema,
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  /** Optional; when omitted the API generates a one-time temporary password. */
  initialPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
});
export type CreateUserRequest = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .strictObject({
    displayName: z.string().trim().min(2).max(120).optional(),
    status: z.enum(USER_STATUSES).optional(),
    roleKeys: roleKeysSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update.');
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;

/** Replaces the set of clients a scoped user (e.g. a Technician) may access. */
export const clientAssignmentsSchema = z.strictObject({
  clientIds: z
    .array(z.uuid())
    .max(1000)
    .refine((v) => new Set(v).size === v.length, 'Clients must be unique.'),
});

export const userListQuerySchema = listQuerySchema.extend({
  status: z.enum(USER_STATUSES).optional(),
  role: z.string().max(63).optional(),
});

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus | 'locked';
  mfaEnabled: boolean;
  authProvider: 'local' | 'oidc';
  roles: { key: string; name: string }[];
  lastLoginAt: string | null;
  createdAt: string;
  isSynthetic: boolean;
}

export interface UserDetail extends UserSummary {
  timezone: string;
  clientScope: ClientScope;
  assignedClients: { id: string; code: string; displayName: string }[];
  updatedAt: string;
}

export interface CreateUserResponse {
  user: UserDetail;
  /** Present only when the API generated the password. Shown once; never retrievable again. */
  temporaryPassword?: string;
}

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  scope: ClientScope;
  permissions: PermissionKey[];
  userCount: number;
}
