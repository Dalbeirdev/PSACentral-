import { z } from 'zod';

export const APP_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export const uuidSchema = z.uuid();

/** Standard list query: server-side pagination, sorting and free-text search. */
export const listQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z
    .string()
    .regex(/^[a-zA-Z]+:(asc|desc)$/, 'sort must look like field:asc or field:desc')
    .optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** RFC 9457 problem details, as returned by every API error. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
}

export const HEALTH_STATES = ['healthy', 'degraded', 'critical', 'offline', 'unknown'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const DEPLOYMENT_LIFECYCLE_STATES = [
  'draft',
  'package_generated',
  'package_downloaded',
  'enrolled',
  'verified',
  'suspended',
  'decommissioned',
] as const;
export type DeploymentLifecycleState = (typeof DEPLOYMENT_LIFECYCLE_STATES)[number];

export const PSA_PROVIDER_KEYS = [
  'autotask',
  'connectwise',
  'halopsa',
  'kaseya_bms',
  'freshservice',
  'servicenow',
  'custom_rest',
] as const;
export type PsaProviderKey = (typeof PSA_PROVIDER_KEYS)[number];

/**
 * Adapter maturity, reported honestly in the UI:
 *  planned          – listed, no adapter code yet
 *  config_only      – configuration can be stored/validated; no API calls
 *  connection_test  – real authentication + API test implemented
 *  sync             – synchronization implemented
 */
export type PsaAdapterStatus = 'planned' | 'config_only' | 'connection_test' | 'sync';

export interface PsaProviderDefinition {
  key: PsaProviderKey;
  name: string;
  vendor: string;
  authMethods: string[];
  adapterStatus: PsaAdapterStatus;
  sortOrder: number;
}



export interface SystemInfo {
  name: string;
  environment: AppEnvironment;
  version: string;
  mfaRequired: boolean;
}
