import { z } from 'zod';
import { listQuerySchema, PSA_PROVIDER_KEYS, type PsaProviderKey } from '../common.js';
import { PSA_PROVIDER_DESCRIPTORS } from './providers.js';
import type { PsaConfigField, PsaProviderDescriptor } from './types.js';

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isHttpsUrlWithoutCredentials(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.');
  } catch {
    return false;
  }
}

const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

function fieldSchema(f: PsaConfigField): z.ZodType {
  switch (f.type) {
    case 'select':
      return z.enum(f.options!.map((o) => o.value) as [string, ...string[]], { error: `Choose a ${f.label.toLowerCase()}.` });
    case 'number':
      return z.coerce
        .number({ error: 'Enter a whole number.' })
        .int('Enter a whole number.')
        .min(f.min ?? 0)
        .max(f.max ?? Number.MAX_SAFE_INTEGER);
    case 'boolean':
      return z.boolean();
    case 'url':
      return z.string().trim().max(300).refine(isHttpsUrlWithoutCredentials, 'Enter an https:// address without credentials in it.');
    case 'host':
      return z
        .string()
        .trim()
        .toLowerCase()
        .regex(HOST, 'Enter a host name such as psa.example.com (no https://).');
    default: {
      let s = z.string().trim().max(f.maxLength ?? 200);
      if (f.pattern) s = s.regex(new RegExp(f.pattern), f.patternMessage ?? 'This value has the wrong format.');
      return s;
    }
  }
}

export function isFieldVisible(f: PsaConfigField, config: Record<string, unknown>): boolean {
  return !f.showWhen || config[f.showWhen.field] === f.showWhen.equals;
}

/**
 * Builds the strict configuration schema for a provider: unknown keys are rejected (so nothing
 * secret can be smuggled into configuration), blanks become undefined, defaults apply, hidden
 * conditional fields are dropped and visible required fields are enforced.
 */
export function buildConfigSchema(descriptor: PsaProviderDescriptor) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of descriptor.configFields) shape[f.key] = z.preprocess(blankToUndefined, fieldSchema(f).optional());
  return z
    .strictObject(shape)
    .superRefine((cfg, ctx) => {
      for (const f of descriptor.configFields) {
        if (f.required && isFieldVisible(f, cfg) && (cfg[f.key] === undefined || cfg[f.key] === null)) {
          ctx.addIssue({ code: 'custom', path: [f.key], message: `${f.label} is required.` });
        }
      }
    })
    .transform((cfg) => {
      const out: Record<string, string | number | boolean> = {};
      for (const f of descriptor.configFields) {
        if (!isFieldVisible(f, cfg)) continue;
        const v = cfg[f.key] ?? f.default;
        if (v !== undefined) out[f.key] = v as string | number | boolean;
      }
      return out;
    });
}

export function configSchemaFor(provider: PsaProviderKey) {
  return buildConfigSchema(PSA_PROVIDER_DESCRIPTORS[provider]);
}

const configRecord = z.record(z.string(), z.unknown()).default({});

export const PSA_INSTANCE_STATUSES = ['active', 'disabled'] as const;
export type PsaInstanceStatus = (typeof PSA_INSTANCE_STATUSES)[number];

const displayName = z.string().trim().min(2, 'Enter a name for this PSA instance.').max(120);
const notes = z.string().trim().max(2000).optional().transform((v) => (v ? v : undefined));
const authMethod = z.string().trim().min(1, 'Choose an authentication method.').max(64);
const serviceIds = z
  .array(z.uuid())
  .max(100)
  .refine((v) => new Set(v).size === v.length, 'Services must be unique.')
  .default([]);

/** Create: provider-specific `config` is validated against the provider schema by the API adapter. */
export const psaInstanceCreateSchema = z.strictObject({
  clientId: z.uuid({ error: 'Choose a client.' }),
  providerKey: z.enum(PSA_PROVIDER_KEYS, { error: 'Choose a PSA provider.' }),
  displayName,
  authMethod,
  config: configRecord,
  notes,
  enabledServiceIds: serviceIds,
});
export type PsaInstanceCreate = z.infer<typeof psaInstanceCreateSchema>;

/** Update: the provider cannot change (create a new instance instead). */
export const psaInstanceUpdateSchema = z.strictObject({
  version: z.string().min(1),
  displayName,
  authMethod,
  config: configRecord,
  notes,
  enabledServiceIds: serviceIds,
  status: z.enum(PSA_INSTANCE_STATUSES),
});
export type PsaInstanceUpdate = z.infer<typeof psaInstanceUpdateSchema>;

export const psaInstanceListQuerySchema = listQuerySchema.extend({
  provider: z.enum(PSA_PROVIDER_KEYS).optional(),
  clientId: z.uuid().optional(),
  connectionStatus: z.enum(['untested', 'succeeded', 'failed']).optional(),
  credentialStatus: z.enum(['not_configured', 'pending_appliance', 'configured', 'invalid', 'expired']).optional(),
  status: z.enum(PSA_INSTANCE_STATUSES).optional(),
});
export type PsaInstanceListQuery = z.infer<typeof psaInstanceListQuerySchema>;

export const deploymentPsaBindingSchema = z.strictObject({ psaInstanceId: z.uuid() });

export interface PsaInstanceSummary {
  id: string;
  code: string;
  displayName: string;
  providerKey: PsaProviderKey;
  providerName: string;
  client: { id: string; code: string; displayName: string };
  apiEndpoint: string | null;
  authMethod: string | null;
  status: PsaInstanceStatus;
  credentialStatus: 'not_configured' | 'pending_appliance' | 'configured' | 'invalid' | 'expired';
  connectionStatus: 'untested' | 'succeeded' | 'failed';
  lastSuccessfulTestAt: string | null;
  lastSyncAt: string | null;
  deploymentCount: number;
  enabledServiceCount: number;
  createdAt: string;
  updatedAt: string;
  isSynthetic: boolean;
}

/** One connection test as run on the appliance (Module 11), derived from agent reports; never credentials. */
export interface PsaConnectionTestDto {
  testedAt: string;
  testedBy: 'local_admin' | 'worker' | 'remote' | null;
  ok: boolean;
  code: string;
  httpStatus: number | null;
  latencyMs: number | null;
  remoteIdentity: Record<string, string>;
  deployment: { id: string; code: string };
  reportedAt: string;
}

/** What the appliance bound to a PSA instance last reported about the connection. */
export interface PsaApplianceStatus {
  deployment: { id: string; code: string; lifecycleState: string; healthState: string };
  status: 'not_configured' | 'credentials_present' | 'verified' | 'failed';
  credentialFields: number;
  credentialsPresent: number;
  apiCallsImplemented: boolean;
  lastTestAt: string | null;
  lastTestCode: string | null;
  lastTestHttpStatus: number | null;
  lastTestLatencyMs: number | null;
  lastTestedBy: 'local_admin' | 'worker' | 'remote' | null;
  lastSuccessAt: string | null;
  remoteIdentity: Record<string, string>;
  consecutiveFailures: number;
  reportedAt: string;
  /** Module 12 — from the appliance's synchronization report (counts and statuses only). */
  sync: {
    implemented: boolean;
    lastRunAt: string | null;
    lastStatus: 'running' | 'succeeded' | 'failed' | 'partial' | null;
    lastSucceededAt: string | null;
    itemsReceived: number;
    itemsSent: number;
    itemsFailed: number;
    errorCode: string | null;
    runsLast24h: number | null;
    failedRunsLast24h: number | null;
  } | null;
  /** Module 12 — from the appliance's ticket metrics report. */
  tickets: { total: number; open: number; pendingOutbound: number | null; conflictsLast24h: number | null; lastProcessedAt: string | null } | null;
}

export interface PsaInstanceDetail extends PsaInstanceSummary {
  /** Latest appliance report for this instance, or null when no appliance has reported yet. */
  appliance: PsaApplianceStatus | null;
  config: Record<string, string | number | boolean>;
  notes: string | null;
  enabledServices: { id: string; key: string; name: string }[];
  /** Client services that may be enabled for this instance (assigned to the client). */
  availableServices: { id: string; key: string; name: string; requiresPsa: boolean }[];
  deployments: { id: string; code: string; lifecycleState: string; healthState: string; boundHere: boolean; isSynthetic: boolean }[];
  createdBy: string | null;
  version: string;
}

/** Fleet view of PSA connections (Integrations page, Module 11). */
export interface IntegrationRow extends PsaInstanceSummary {
  appliance: PsaApplianceStatus | null;
}

export const integrationListQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  provider: z.enum(PSA_PROVIDER_KEYS).optional(),
  connectionStatus: z.enum(['untested', 'succeeded', 'failed']).optional(),
  credentialStatus: z.enum(['not_configured', 'pending_appliance', 'configured', 'invalid', 'expired']).optional(),
  live: z.enum(['1']).optional(),
});
export type IntegrationListQuery = z.infer<typeof integrationListQuerySchema>;
