import { z } from 'zod';
import type { PsaCapabilities } from './psa/types.js';

/**
 * Service catalog contracts (Module 2 defaults, Module 4 administration).
 *
 * The catalog is database-driven and per organization: `DEFAULT_SERVICE_CATEGORIES` / `DEFAULT_SERVICES`
 * are only the rows every organization starts with (missing keys are added by the migrator; existing rows,
 * possibly edited by administrators, are never overwritten).
 */

// ---------------------------------------------------------------------------
// Integration dependencies — a fixed vocabulary, so the platform can reason about them
// ---------------------------------------------------------------------------

export interface IntegrationDependencyDefinition {
  key: string;
  label: string;
  /** `psa`: data in the client's PSA (checked against the adapter's capabilities); `platform`: another system. */
  kind: 'psa' | 'platform';
  /** PSA capability that must be supported by the provider, when the adapter framework models it. */
  capability: keyof PsaCapabilities | null;
  description: string;
}

export const INTEGRATION_DEPENDENCIES = [
  { key: 'psa.tickets', label: 'PSA tickets', kind: 'psa', capability: 'tickets', description: 'Creates and updates tickets in the client’s PSA.' },
  { key: 'psa.ticket_notes', label: 'PSA ticket notes', kind: 'psa', capability: 'ticketNotes', description: 'Adds notes and replies to PSA tickets.' },
  { key: 'psa.time_entries', label: 'PSA time entries', kind: 'psa', capability: 'timeEntries', description: 'Records technician time against PSA tickets.' },
  { key: 'psa.companies', label: 'PSA companies', kind: 'psa', capability: 'companies', description: 'Reads the client’s company record from the PSA.' },
  { key: 'psa.contacts', label: 'PSA contacts', kind: 'psa', capability: 'contacts', description: 'Reads and matches end-user contacts in the PSA.' },
  { key: 'psa.configuration_items', label: 'PSA configuration items', kind: 'psa', capability: 'configurationItems', description: 'Links devices and assets to PSA configuration items.' },
  { key: 'psa.attachments', label: 'PSA attachments', kind: 'psa', capability: 'attachments', description: 'Attaches files to PSA tickets (on the appliance only).' },
  { key: 'psa.quotes', label: 'PSA quotes', kind: 'psa', capability: null, description: 'Quotes and opportunities in the PSA; adapter support is decided per provider when ticket processing ships (Module 12).' },
  { key: 'psa.projects', label: 'PSA projects', kind: 'psa', capability: null, description: 'Projects and milestones in the PSA; adapter support is decided per provider (Module 12).' },
  { key: 'rmm', label: 'RMM platform', kind: 'platform', capability: null, description: 'Remote monitoring and management tooling. Not integrated by this platform yet.' },
  { key: 'm365', label: 'Microsoft 365 tenant', kind: 'platform', capability: null, description: 'Delegated administration of the client’s Microsoft 365 tenant. Not integrated by this platform yet.' },
  { key: 'backup', label: 'Backup platform', kind: 'platform', capability: null, description: 'Backup monitoring and restores. Not integrated by this platform yet.' },
  { key: 'edr', label: 'EDR / security platform', kind: 'platform', capability: null, description: 'Endpoint detection and response alerts. Not integrated by this platform yet.' },
  { key: 'email_security', label: 'Email security platform', kind: 'platform', capability: null, description: 'Mail filtering and phishing protection. Not integrated by this platform yet.' },
] as const satisfies readonly IntegrationDependencyDefinition[];

export type IntegrationDependencyKey = (typeof INTEGRATION_DEPENDENCIES)[number]['key'];
export const INTEGRATION_DEPENDENCY_KEYS = INTEGRATION_DEPENDENCIES.map((d) => d.key) as [IntegrationDependencyKey, ...IntegrationDependencyKey[]];

export function integrationDependency(key: string): IntegrationDependencyDefinition | undefined {
  return INTEGRATION_DEPENDENCIES.find((d) => d.key === key);
}

// ---------------------------------------------------------------------------
// Configuration requirements — settings a client must supply when a service is assigned
// ---------------------------------------------------------------------------

export const CONFIG_REQUIREMENT_TYPES = ['text', 'number', 'boolean', 'select', 'url'] as const;
export type ConfigRequirementType = (typeof CONFIG_REQUIREMENT_TYPES)[number];

/** Keys or labels that look like credentials are refused: the catalog never carries secrets (they live on the appliance). */
export const SECRET_LIKE = /pass(word)?|secret|token|api[-_ ]?key|credential|private[-_ ]?key|client[-_ ]?secret/i;

export const configRequirementSchema = z
  .strictObject({
    key: z.string().regex(/^[a-z][a-zA-Z0-9]{1,39}$/, 'Use a camelCase key: letters and digits, starting with a lowercase letter.'),
    label: z.string().trim().min(2, 'Enter a label.').max(60),
    type: z.enum(CONFIG_REQUIREMENT_TYPES, { error: 'Choose a type.' }),
    required: z.boolean().default(false),
    description: z.string().trim().max(200).optional(),
    placeholder: z.string().trim().max(80).optional(),
    options: z
      .array(z.strictObject({ value: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(60) }))
      .min(2, 'A select needs at least two options.')
      .max(20)
      .optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .superRefine((r, ctx) => {
    if (SECRET_LIKE.test(r.key) || SECRET_LIKE.test(r.label)) {
      ctx.addIssue({ code: 'custom', path: ['key'], message: 'Credentials are entered on the client’s appliance; the catalog holds no secrets.' });
    }
    if (r.type === 'select' && !r.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'A select needs options.' });
    if (r.type !== 'select' && r.options) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only a select has options.' });
    if (r.type === 'select' && r.options && new Set(r.options.map((o) => o.value)).size !== r.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option values must be unique.' });
    }
    if (r.type !== 'number' && (r.min !== undefined || r.max !== undefined)) ctx.addIssue({ code: 'custom', path: ['min'], message: 'Only a number has a range.' });
    if (r.min !== undefined && r.max !== undefined && r.min > r.max) ctx.addIssue({ code: 'custom', path: ['max'], message: 'The maximum must not be below the minimum.' });
  });
export type ConfigRequirement = z.infer<typeof configRequirementSchema>;

export const configRequirementsSchema = z
  .array(configRequirementSchema)
  .max(20, 'A service can require at most 20 settings.')
  .refine((rs) => new Set(rs.map((r) => r.key)).size === rs.length, 'Setting keys must be unique.');

export type ServiceConfigValue = string | number | boolean;
export type ServiceConfigValues = Record<string, ServiceConfigValue>;

/** Values a client supplies for a service's requirements. Shape only; the requirements decide what is valid. */
export const serviceConfigValuesSchema = z.record(z.string().max(40), z.union([z.string().max(500), z.number().finite(), z.boolean()]));

export interface ConfigIssue {
  path: string;
  message: string;
}

/**
 * Validates and normalizes a client's values against a service's requirements.
 * Empty strings for optional settings are dropped; unknown keys are refused. Pure: used by the API and the UI.
 */
export function checkServiceConfig(requirements: ConfigRequirement[], values: Record<string, unknown> | null | undefined): { config: ServiceConfigValues; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const config: ServiceConfigValues = {};
  const input = values ?? {};
  for (const k of Object.keys(input)) {
    if (!requirements.some((r) => r.key === k)) issues.push({ path: k, message: 'This setting is not defined by the service.' });
  }
  for (const r of requirements) {
    const raw = input[r.key];
    const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
    if (empty) {
      if (r.required) issues.push({ path: r.key, message: `${r.label} is required.` });
      continue;
    }
    switch (r.type) {
      case 'text': {
        if (typeof raw !== 'string') issues.push({ path: r.key, message: `${r.label} must be text.` });
        else if (raw.length > 500) issues.push({ path: r.key, message: `${r.label} must be at most 500 characters.` });
        else config[r.key] = raw.trim();
        break;
      }
      case 'url': {
        let ok = false;
        if (typeof raw === 'string' && raw.length <= 500) {
          try {
            const u = new URL(raw.trim());
            ok = u.protocol === 'https:' || u.protocol === 'http:';
          } catch {
            ok = false;
          }
        }
        if (!ok) issues.push({ path: r.key, message: `${r.label} must be an http(s) URL.` });
        else config[r.key] = (raw as string).trim();
        break;
      }
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        if (!Number.isFinite(n)) issues.push({ path: r.key, message: `${r.label} must be a number.` });
        else if (r.min !== undefined && n < r.min) issues.push({ path: r.key, message: `${r.label} must be at least ${r.min}.` });
        else if (r.max !== undefined && n > r.max) issues.push({ path: r.key, message: `${r.label} must be at most ${r.max}.` });
        else config[r.key] = n;
        break;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') config[r.key] = raw;
        else if (raw === 'true' || raw === 'false') config[r.key] = raw === 'true';
        else issues.push({ path: r.key, message: `${r.label} must be yes or no.` });
        break;
      }
      case 'select': {
        if (typeof raw !== 'string' || !r.options?.some((o) => o.value === raw)) issues.push({ path: r.key, message: `Choose one of the options for ${r.label}.` });
        else config[r.key] = raw;
        break;
      }
    }
  }
  return { config, issues };
}

// ---------------------------------------------------------------------------
// Defaults every organization starts with
// ---------------------------------------------------------------------------

export interface ServiceCategoryDefinition {
  key: string;
  name: string;
  sortOrder: number;
}

export interface ServiceDefinition {
  key: string;
  name: string;
  category: string;
  description: string;
  isDefault: boolean;
  requiresPsa: boolean;
  integrationDependencies: IntegrationDependencyKey[];
  configRequirements?: ConfigRequirement[];
  sortOrder: number;
}

export const DEFAULT_SERVICE_CATEGORIES: ServiceCategoryDefinition[] = [
  { key: 'support', name: 'Support', sortOrder: 10 },
  { key: 'endpoint', name: 'Endpoint & assets', sortOrder: 20 },
  { key: 'security', name: 'Security', sortOrder: 30 },
  { key: 'infrastructure', name: 'Infrastructure & cloud', sortOrder: 40 },
  { key: 'business', name: 'Business services', sortOrder: 50 },
  { key: 'custom', name: 'Custom', sortOrder: 90 },
];

export const DEFAULT_SERVICES: ServiceDefinition[] = [
  {
    key: 'help_desk', name: 'Help Desk', category: 'support', description: 'Ticket intake, triage and resolution through the client’s PSA.', isDefault: true, requiresPsa: true,
    integrationDependencies: ['psa.tickets', 'psa.ticket_notes', 'psa.contacts'], sortOrder: 10,
    configRequirements: [
      { key: 'defaultPriority', label: 'Default ticket priority', type: 'select', required: false, description: 'Priority given to tickets the appliance creates when the source sets none.', options: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
      { key: 'supportHours', label: 'Support hours', type: 'select', required: false, options: [{ value: 'business', label: 'Business hours' }, { value: 'extended', label: 'Extended (7–22)' }, { value: '24x7', label: '24×7' }] },
    ],
  },
  { key: 'remote_support', name: 'Remote Support', category: 'support', description: 'Attended and unattended remote sessions.', isDefault: false, requiresPsa: false, integrationDependencies: [], sortOrder: 20 },
  { key: 'endpoint_management', name: 'Endpoint Management', category: 'endpoint', description: 'Device configuration, monitoring and compliance.', isDefault: false, requiresPsa: false, integrationDependencies: ['rmm'], sortOrder: 30 },
  { key: 'patch_management', name: 'Patch Management', category: 'endpoint', description: 'Operating system and third-party patching.', isDefault: false, requiresPsa: false, integrationDependencies: ['rmm'], sortOrder: 40,
    configRequirements: [{ key: 'maintenanceWindow', label: 'Maintenance window', type: 'text', required: false, placeholder: 'e.g. Sat 02:00–06:00', description: 'When patches may reboot devices.' }] },
  { key: 'asset_management', name: 'Asset Management', category: 'endpoint', description: 'Hardware and software inventory, lifecycle tracking.', isDefault: false, requiresPsa: true, integrationDependencies: ['psa.configuration_items'], sortOrder: 50 },
  { key: 'microsoft_365', name: 'Microsoft 365', category: 'infrastructure', description: 'Tenant administration, licensing and support.', isDefault: false, requiresPsa: false, integrationDependencies: ['m365'], sortOrder: 60,
    configRequirements: [{ key: 'tenantDomain', label: 'Tenant domain', type: 'text', required: false, placeholder: 'contoso.onmicrosoft.com', description: 'The client’s Microsoft 365 tenant. No credentials.' }] },
  { key: 'backup_management', name: 'Backup Management', category: 'infrastructure', description: 'Backup monitoring, restores and retention.', isDefault: false, requiresPsa: false, integrationDependencies: ['backup'], sortOrder: 70,
    configRequirements: [{ key: 'retentionDays', label: 'Retention (days)', type: 'number', required: false, min: 1, max: 3650 }] },
  { key: 'network_management', name: 'Network Management', category: 'infrastructure', description: 'Switching, wireless and connectivity management.', isDefault: false, requiresPsa: false, integrationDependencies: [], sortOrder: 80 },
  { key: 'firewall_management', name: 'Firewall Management', category: 'infrastructure', description: 'Firewall policy, VPN and perimeter changes.', isDefault: false, requiresPsa: false, integrationDependencies: [], sortOrder: 90 },
  { key: 'email_security', name: 'Email Security', category: 'security', description: 'Filtering, phishing protection and DMARC.', isDefault: false, requiresPsa: false, integrationDependencies: ['email_security'], sortOrder: 100 },
  { key: 'cybersecurity', name: 'Cybersecurity', category: 'security', description: 'Security posture management and advisory.', isDefault: false, requiresPsa: false, integrationDependencies: [], sortOrder: 110 },
  { key: 'security_monitoring', name: 'Security Monitoring', category: 'security', description: 'Alert monitoring and escalation for security events.', isDefault: false, requiresPsa: true, integrationDependencies: ['psa.tickets', 'edr'], sortOrder: 115 },
  { key: 'soc_mdr', name: 'SOC/MDR', category: 'security', description: 'Managed detection and response with 24×7 SOC.', isDefault: false, requiresPsa: true, integrationDependencies: ['psa.tickets', 'edr'], sortOrder: 120 },
  { key: 'vulnerability_management', name: 'Vulnerability Management', category: 'security', description: 'Scanning, prioritization and remediation tracking.', isDefault: false, requiresPsa: false, integrationDependencies: [], sortOrder: 130 },
  { key: 'security_awareness_training', name: 'Security Awareness Training', category: 'security', description: 'Training campaigns and phishing simulations.', isDefault: false, requiresPsa: false, integrationDependencies: [], sortOrder: 140 },
  { key: 'procurement', name: 'Procurement', category: 'business', description: 'Hardware and software sourcing and quoting.', isDefault: false, requiresPsa: true, integrationDependencies: ['psa.quotes'], sortOrder: 150 },
  { key: 'project_management', name: 'Project Management', category: 'business', description: 'Scoped projects with milestones and time tracking.', isDefault: false, requiresPsa: true, integrationDependencies: ['psa.projects', 'psa.time_entries'], sortOrder: 160 },
  { key: 'custom_services', name: 'Custom Services', category: 'custom', description: 'Client-specific services defined per agreement.', isDefault: false, requiresPsa: false, integrationDependencies: [], sortOrder: 900 },
];

// ---------------------------------------------------------------------------
// Administration (Module 4)
// ---------------------------------------------------------------------------

const serviceKey = z.string().regex(/^[a-z][a-z0-9_]{1,60}$/, 'Use lowercase letters, digits and underscores, starting with a letter (2–61 characters).');
const categoryKey = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Use lowercase letters, digits and underscores, starting with a letter (2–41 characters).');
const name = z.string().trim().min(2, 'Enter a name.').max(80);
const sortOrder = z.coerce.number().int().min(0).max(10_000).default(100);
const dependencies = z
  .array(z.enum(INTEGRATION_DEPENDENCY_KEYS, { error: 'Choose dependencies from the list.' }))
  .max(20)
  .refine((v) => new Set(v).size === v.length, 'Dependencies must be unique.')
  .default([]);

const serviceFields = {
  name,
  description: z.string().trim().max(500).default(''),
  categoryId: z.uuid({ error: 'Choose a category.' }),
  isDefault: z.boolean().default(false),
  requiresPsa: z.boolean().default(false),
  integrationDependencies: dependencies,
  configRequirements: configRequirementsSchema.default([]),
  sortOrder,
};

function psaConsistency(v: { requiresPsa: boolean; integrationDependencies: string[] }, ctx: z.RefinementCtx) {
  if (!v.requiresPsa && v.integrationDependencies.some((d) => integrationDependency(d)?.kind === 'psa')) {
    ctx.addIssue({ code: 'custom', path: ['requiresPsa'], message: 'A service that depends on PSA data runs through the client’s PSA. Turn on “Uses the client’s PSA”.' });
  }
}

export const serviceCreateSchema = z.strictObject({ key: serviceKey, ...serviceFields }).superRefine(psaConsistency);
export type ServiceCreate = z.infer<typeof serviceCreateSchema>;

/** The key is immutable: appliances store service configuration by key. */
export const serviceUpdateSchema = z.strictObject({ version: z.string().min(1), ...serviceFields }).superRefine(psaConsistency);
export type ServiceUpdate = z.infer<typeof serviceUpdateSchema>;

/** Activate / deactivate carry the version the operator looked at. */
export const serviceStatusSchema = z.strictObject({ version: z.string().min(1) });

export const serviceListQuerySchema = z.strictObject({
  q: z.string().trim().max(200).optional(),
  category: categoryKey.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  dependency: z.enum(INTEGRATION_DEPENDENCY_KEYS).optional(),
  usesPsa: z.enum(['1', '0']).optional(),
});
export type ServiceListQuery = z.infer<typeof serviceListQuerySchema>;

export const serviceCategoryCreateSchema = z.strictObject({ key: categoryKey, name, sortOrder });
export type ServiceCategoryCreate = z.infer<typeof serviceCategoryCreateSchema>;
export const serviceCategoryUpdateSchema = z.strictObject({ version: z.string().min(1), name, sortOrder });
export type ServiceCategoryUpdate = z.infer<typeof serviceCategoryUpdateSchema>;

/** Suggests a catalog key from a display name ("Dark Web Monitoring" → "dark_web_monitoring"). */
export function suggestServiceKey(name: string): string {
  const k = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 61);
  return k.length >= 2 ? k : '';
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface ServiceDto {
  id: string;
  key: string;
  name: string;
  description: string;
  category: { id: string; key: string; name: string };
  isActive: boolean;
  isDefault: boolean;
  requiresPsa: boolean;
  integrationDependencies: IntegrationDependencyKey[];
  configRequirements: ConfigRequirement[];
  sortOrder: number;
}

export interface ServiceSummary extends ServiceDto {
  /** Clients the service is assigned to (any client status). */
  clientCount: number;
  updatedAt: string;
}

export interface ServiceDetail extends ServiceSummary {
  clients: { id: string; code: string; displayName: string; status: string; configComplete: boolean; isSynthetic: boolean }[];
  /** Deployments of the assigned clients that are not decommissioned. */
  deploymentCount: number;
  createdAt: string;
  createdBy: string | null;
  updatedBy: string | null;
  version: string;
}

export interface ServiceCategoryDto {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  serviceCount: number;
  activeServiceCount: number;
  version: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClientServiceDto extends ServiceDto {
  enabledAt: string;
  enabledBy: string | null;
  /** Non-secret values for the service's configuration requirements. */
  config: ServiceConfigValues;
  /** What is still missing or invalid (empty when complete). */
  configIssues: ConfigIssue[];
}

export const clientServicesUpdateSchema = z.strictObject({
  serviceIds: z
    .array(z.uuid())
    .max(100)
    .refine((v) => new Set(v).size === v.length, 'Services must be unique.'),
  /** Per service id: values for its configuration requirements. Services without an entry keep their current values. */
  config: z.record(z.uuid(), serviceConfigValuesSchema).default({}),
});
export type ClientServicesUpdate = z.infer<typeof clientServicesUpdateSchema>;
