import { z } from 'zod';
import { emailSchema } from './auth.js';
import { type HealthState, listQuerySchema, type DeploymentLifecycleState, type PsaProviderKey } from './common.js';
import { BUSINESS_TYPES, COUNTRY_CODES, isValidTimeZone } from './reference.js';

export const CLIENT_STATUSES = ['prospect', 'onboarding', 'active', 'suspended', 'offboarded'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export const SERVICE_STATUSES = ['not_started', 'in_progress', 'live', 'paused', 'terminated'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export const CONTACT_ROLES = ['primary', 'technical', 'billing', 'escalation', 'other'] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const isoDate = z.iso.date({ error: 'Use the format YYYY-MM-DD.' });
const optionalDate = z
  .union([isoDate, z.literal('')])
  .optional()
  .transform((v) => (v ? v : undefined));
const optionalUuid = z
  .union([z.uuid(), z.literal('')])
  .optional()
  .transform((v) => (v ? v : undefined));

export const timezoneSchema = z.string().trim().min(1, 'Choose a time zone.').max(64).refine(isValidTimeZone, 'Choose a valid IANA time zone.');

export const websiteSchema = z
  .string()
  .trim()
  .max(300)
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => {
    if (!v) return true;
    try {
      const u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Enter a full web address starting with https://');

export const phoneSchema = z
  .string()
  .trim()
  .max(40)
  .optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => !v || /^\+?[0-9][0-9 ().-]{5,28}[0-9](\s*(x|ext\.?)\s*\d{1,6})?$/i.test(v), 'Enter a valid phone number, e.g. +1 555 0100 or +44 20 7946 0000.');

/** Company information block. Shared by the onboarding wizard (step 1) and the edit page. */
export const clientCompanySchema = z.strictObject({
  legalName: z.string().trim().min(2, 'Enter the legal company name.').max(200),
  displayName: z.string().trim().min(2, 'Enter a display name.').max(120),
  clientReference: z
    .string()
    .trim()
    .min(1, 'Enter a client reference.')
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/ ]*$/, 'Use letters, numbers, spaces and . _ - / only.'),
  businessType: z.enum(BUSINESS_TYPES, { error: 'Choose a business type.' }),
  countryCode: z.string().refine((c) => COUNTRY_CODES.includes(c), 'Choose a country.'),
  stateRegion: optionalText(100),
  city: optionalText(100),
  timezone: timezoneSchema,
  website: websiteSchema,
});
export type ClientCompany = z.infer<typeof clientCompanySchema>;

export const clientManagementSchema = z
  .strictObject({
    accountManagerUserId: optionalUuid,
    technicalOwnerUserId: optionalUuid,
    onboardingDate: optionalDate,
    contractStartDate: optionalDate,
    contractEndDate: optionalDate,
    internalNotes: optionalText(10_000),
  })
  .refine((v) => !v.contractStartDate || !v.contractEndDate || v.contractEndDate >= v.contractStartDate, {
    message: 'The contract end date must be on or after the start date.',
    path: ['contractEndDate'],
  });
export type ClientManagement = z.infer<typeof clientManagementSchema>;

export const contactSchema = z.strictObject({
  fullName: z.string().trim().min(2, 'Enter the contact’s name.').max(120),
  jobTitle: optionalText(120),
  email: emailSchema,
  phone: phoneSchema,
  mobile: phoneSchema,
  roles: z
    .array(z.enum(CONTACT_ROLES))
    .min(1, 'Choose at least one role.')
    .max(CONTACT_ROLES.length)
    .refine((r) => new Set(r).size === r.length, 'Roles must be unique.'),
  notes: optionalText(2000),
});
export type ContactInput = z.infer<typeof contactSchema>;

/** A contact list must have exactly one primary contact and unique emails. */
export const contactListSchema = z
  .array(contactSchema)
  .min(1, 'Add at least one contact.')
  .max(25)
  .superRefine((list, ctx) => {
    const primaries = list.filter((c) => c.roles.includes('primary')).length;
    if (primaries !== 1) ctx.addIssue({ code: 'custom', message: primaries === 0 ? 'Mark one contact as the primary contact.' : 'Only one contact can be the primary contact.', path: [] });
    const seen = new Map<string, number>();
    list.forEach((c, i) => {
      if (seen.has(c.email)) ctx.addIssue({ code: 'custom', message: 'Each contact needs a different email address.', path: [i, 'email'] });
      seen.set(c.email, i);
    });
  });

export const clientUpdateSchema = z.strictObject({
  version: z.string().min(1),
  company: clientCompanySchema,
  management: clientManagementSchema,
  status: z.enum(CLIENT_STATUSES),
  serviceStatus: z.enum(SERVICE_STATUSES),
});
export type ClientUpdateRequest = z.infer<typeof clientUpdateSchema>;

export const clientListQuerySchema = listQuerySchema.extend({
  status: z.enum(CLIENT_STATUSES).optional(),
  serviceStatus: z.enum(SERVICE_STATUSES).optional(),
  country: z.string().length(2).regex(/^[A-Z]{2}$/).optional(),
  provider: z.string().regex(/^[a-z_]{2,40}$/).optional(),
  accountManager: z.uuid().optional(),
  health: z.enum(['healthy', 'degraded', 'critical', 'offline', 'unknown']).optional(),
});
export type ClientListQuery = z.infer<typeof clientListQuerySchema>;

export const duplicateCheckQuerySchema = z.strictObject({
  reference: z.string().trim().max(64).optional(),
  legalName: z.string().trim().max(200).optional(),
  displayName: z.string().trim().max(120).optional(),
  excludeId: z.uuid().optional(),
});

export interface UserRef {
  id: string;
  displayName: string;
  email?: string;
}

export interface ClientSummary {
  id: string;
  code: string;
  displayName: string;
  legalName: string;
  clientReference: string;
  status: ClientStatus;
  serviceStatus: ServiceStatus;
  businessType: string | null;
  countryCode: string | null;
  city: string | null;
  psaProviders: { key: PsaProviderKey; name: string }[];
  deploymentCount: number;
  health: Record<HealthState, number>;
  accountManager: UserRef | null;
  onboardingDate: string | null;
  createdAt: string;
  isSynthetic: boolean;
}

export interface ClientDetail extends ClientSummary {
  stateRegion: string | null;
  timezone: string;
  website: string | null;
  technicalOwner: UserRef | null;
  contractStartDate: string | null;
  contractEndDate: string | null;
  internalNotes: string | null;
  primaryContact: ContactDto | null;
  counts: { contacts: number; services: number; psaInstances: number; deployments: number };
  assignedTechnicians: UserRef[];
  createdBy: UserRef | null;
  updatedAt: string;
  /** Opaque optimistic-concurrency token; send it back on update. */
  version: string;
}

export interface ContactDto {
  id: string;
  fullName: string;
  jobTitle: string | null;
  email: string;
  phone: string | null;
  mobile: string | null;
  roles: ContactRole[];
  notes: string | null;
  isSynthetic: boolean;
  updatedAt: string;
}

export interface ClientPsaInstanceDto {
  id: string;
  code: string;
  providerKey: PsaProviderKey;
  providerName: string;
  displayName: string;
  apiEndpoint: string | null;
  authMethod: string | null;
  credentialStatus: string;
  connectionStatus: 'untested' | 'succeeded' | 'failed';
  lastSuccessfulTestAt: string | null;
  createdAt: string;
  isSynthetic: boolean;
}

export interface ClientDeploymentDto {
  id: string;
  code: string;
  psaInstanceCode: string | null;
  targetEnvironment: string;
  targetOs: string | null;
  targetArch: string | null;
  hostLabel: string | null;
  lifecycleState: DeploymentLifecycleState;
  healthState: HealthState;
  healthReason: string | null;
  imageVersion: string | null;
  lastHeartbeatAt: string | null;
  enrolledAt: string | null;
  createdAt: string;
  isSynthetic: boolean;
}

export interface ClientHealthDto {
  summary: Record<HealthState, number>;
  deployments: ClientDeploymentDto[];
  events: { deploymentCode: string; healthState: HealthState; reason: string | null; source: 'agent' | 'system' | 'synthetic'; observedAt: string }[];
}

export interface DuplicateCheckResponse {
  referenceAvailable: boolean | null;
  similar: { id: string; code: string; displayName: string; legalName: string }[];
}
