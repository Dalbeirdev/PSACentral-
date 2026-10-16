import { z } from 'zod';
import { clientCompanySchema, clientManagementSchema, contactListSchema } from './clients.js';
import { PSA_PROVIDER_KEYS } from './common.js';
import { serviceConfigValuesSchema } from './services.js';

/** The ten wizard steps, in order. Each has its own URL: /clients/new/[draftId]/[step]. */
export const ONBOARDING_STEPS = [
  { key: 'client', number: 1, title: 'Client information', short: 'Client' },
  { key: 'psa-provider', number: 2, title: 'PSA provider', short: 'PSA provider' },
  { key: 'psa-config', number: 3, title: 'PSA configuration', short: 'PSA config' },
  { key: 'services', number: 4, title: 'Services', short: 'Services' },
  { key: 'deployment', number: 5, title: 'Deployment preferences', short: 'Deployment' },
  { key: 'review', number: 6, title: 'Review', short: 'Review' },
  { key: 'create', number: 7, title: 'Create deployment', short: 'Create' },
  { key: 'download', number: 8, title: 'Download package', short: 'Download' },
  { key: 'verify', number: 9, title: 'Verify installation', short: 'Verify' },
  { key: 'complete', number: 10, title: 'Complete', short: 'Complete' },
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];

/** Steps whose data is captured in the draft (before records are created). */
export const DATA_STEPS = ['client', 'psa-provider', 'psa-config', 'services', 'deployment'] as const;
export type DataStepKey = (typeof DATA_STEPS)[number];

export const TARGET_ENVIRONMENTS = [
  { key: 'windows_docker', label: 'Windows Docker host', os: 'windows' },
  { key: 'linux_docker', label: 'Linux Docker host', os: 'linux' },
  { key: 'virtual_machine', label: 'Virtual machine', os: null },
  { key: 'client_server', label: 'Client server', os: null },
  { key: 'cloud_vm', label: 'Cloud VM', os: null },
  { key: 'local_test', label: 'Local testing environment', os: null },
] as const;
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number]['key'];

export const clientStepSchema = z.strictObject({
  company: clientCompanySchema,
  management: clientManagementSchema,
  contacts: contactListSchema,
});

export const psaProviderStepSchema = z.strictObject({
  providerKey: z.enum(PSA_PROVIDER_KEYS, { error: 'Choose a PSA provider.' }),
});

/**
 * Step 3. `config` holds the provider-specific, non-secret settings; the API validates it with the
 * provider adapter's schema and derives the API endpoint from it.
 */
export const psaConfigStepSchema = z.strictObject({
  displayName: z.string().trim().min(2, 'Enter a name for this PSA instance.').max(120),
  authMethod: z.string().trim().min(1, 'Choose an authentication method.').max(64),
  config: z.record(z.string(), z.unknown()).default({}),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : undefined)),
});

export const servicesStepSchema = z.strictObject({
  serviceIds: z
    .array(z.uuid())
    .min(1, 'Select at least one service.')
    .max(100)
    .refine((v) => new Set(v).size === v.length, 'Services must be unique.'),
  /** Per selected service id: values for its configuration requirements (validated against the catalog on save). */
  config: z.record(z.uuid(), serviceConfigValuesSchema).default({}),
});

export const deploymentStepSchema = z
  .strictObject({
    targetEnvironment: z.enum(TARGET_ENVIRONMENTS.map((t) => t.key) as [TargetEnvironment, ...TargetEnvironment[]], {
      error: 'Choose where the appliance will run.',
    }),
    targetOs: z.enum(['linux', 'windows'], { error: 'Choose the host operating system.' }),
    targetArch: z.enum(['amd64', 'arm64'], { error: 'Choose the CPU architecture.' }),
    hostLabel: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'Use letters, numbers, spaces and . _ - only.')
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .refine((v) => {
    const fixed = TARGET_ENVIRONMENTS.find((t) => t.key === v.targetEnvironment)?.os;
    return !fixed || fixed === v.targetOs;
  }, { message: 'The operating system must match the selected environment.', path: ['targetOs'] });

export const STEP_SCHEMAS = {
  client: clientStepSchema,
  'psa-provider': psaProviderStepSchema,
  'psa-config': psaConfigStepSchema,
  services: servicesStepSchema,
  deployment: deploymentStepSchema,
} satisfies Record<DataStepKey, z.ZodType>;

export interface OnboardingDraftData {
  client?: z.infer<typeof clientStepSchema>;
  'psa-provider'?: z.infer<typeof psaProviderStepSchema>;
  'psa-config'?: z.infer<typeof psaConfigStepSchema>;
  services?: z.infer<typeof servicesStepSchema>;
  deployment?: z.infer<typeof deploymentStepSchema>;
}

export type DraftStatus = 'in_progress' | 'completed' | 'abandoned';

export interface OnboardingResult {
  clientId: string;
  clientCode: string;
  psaInstanceId: string;
  psaInstanceCode: string;
  deploymentId: string;
  deploymentCode: string;
  /** Module 14: the client's first license, created by the wizard and bound to the deployment. */
  licenseId: string;
  licenseCode: string;
  contactCount: number;
  serviceCount: number;
}

export interface OnboardingDraftDto {
  id: string;
  status: DraftStatus;
  currentStep: OnboardingStepKey;
  completedSteps: DataStepKey[];
  data: OnboardingDraftData;
  /** Optimistic concurrency token: send it back when saving a step. */
  version: number;
  result: OnboardingResult | null;
  createdBy: { id: string; displayName: string };
  updatedBy: { id: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OnboardingDraftSummary {
  id: string;
  status: DraftStatus;
  currentStep: OnboardingStepKey;
  completedSteps: DataStepKey[];
  clientName: string | null;
  createdBy: string;
  updatedAt: string;
}

export const saveStepSchema = z.strictObject({
  version: z.number().int().min(1),
  data: z.unknown(),
});

export const completeDraftSchema = z.strictObject({
  version: z.number().int().min(1),
  confirm: z.literal(true, { error: 'Confirm that you reviewed the details.' }),
});
