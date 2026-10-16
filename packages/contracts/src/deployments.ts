import { z } from 'zod';
import { type DeploymentLifecycleState, DEPLOYMENT_LIFECYCLE_STATES, type HealthState, HEALTH_STATES, type PsaProviderKey } from './common.js';
import type { DeploymentLicenseInfo, DeploymentSuspension, LicenseStatus } from './licenses.js';
import type { DeploymentDecommissionInfo } from './retention.js';
import type { ApplianceLicenseStatus } from './license-tokens.js';
import { TARGET_ENVIRONMENTS, type TargetEnvironment } from './onboarding.js';

export const LIFECYCLE_LABELS: Record<DeploymentLifecycleState, string> = {
  draft: 'Draft — no package',
  package_generated: 'Package generated',
  package_downloaded: 'Package downloaded',
  enrolled: 'Enrolled',
  verified: 'Verified',
  suspended: 'Suspended',
  decommissioned: 'Decommissioned',
};

/** Lifecycle states in which a package may be generated, regenerated or revoked (before the agent enrolls). */
export const PRE_ENROLLMENT_STATES = ['draft', 'package_generated', 'package_downloaded'] as const satisfies readonly DeploymentLifecycleState[];

export const PACKAGE_STATUSES = ['active', 'expired', 'superseded', 'revoked', 'consumed'] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];
export const PACKAGE_STATUS_LABELS: Record<PackageStatus, string> = {
  active: 'Ready to download',
  expired: 'Expired — token no longer valid',
  superseded: 'Replaced by a newer package',
  revoked: 'Revoked',
  consumed: 'Used for enrollment',
};

export type EnrollmentTokenStatus = 'active' | 'expired' | 'revoked' | 'consumed';

/** Allowed enrollment-token lifetimes, in hours. Tokens are short-lived and single-use. */
export const TOKEN_VALIDITY_HOURS = [1, 4, 24, 72] as const;

const hostLabel = z
  .string()
  .trim()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'Use letters, numbers, spaces and . _ - only.')
  .optional()
  .or(z.literal('').transform(() => undefined));

const targetFields = {
  targetEnvironment: z.enum(TARGET_ENVIRONMENTS.map((t) => t.key) as [TargetEnvironment, ...TargetEnvironment[]], {
    error: 'Choose where the appliance will run.',
  }),
  targetOs: z.enum(['linux', 'windows'], { error: 'Choose the host operating system.' }),
  targetArch: z.enum(['amd64', 'arm64'], { error: 'Choose the CPU architecture.' }),
  hostLabel,
};

const osMatchesEnvironment = (v: { targetEnvironment: TargetEnvironment; targetOs: string }) => {
  const fixed = TARGET_ENVIRONMENTS.find((t) => t.key === v.targetEnvironment)?.os;
  return !fixed || fixed === v.targetOs;
};
const osRule = { message: 'The operating system must match the selected environment.', path: ['targetOs'] };

export const deploymentCreateSchema = z
  .strictObject({ clientId: z.uuid({ error: 'Choose a client.' }), psaInstanceId: z.uuid({ error: 'Choose a PSA instance.' }), licenseId: z.uuid().optional(), ...targetFields })
  .refine(osMatchesEnvironment, osRule);
export type DeploymentCreate = z.infer<typeof deploymentCreateSchema>;

export const deploymentUpdateSchema = z
  .strictObject({ version: z.string().regex(/^\d+$/), psaInstanceId: z.uuid({ error: 'Choose a PSA instance.' }), licenseId: z.uuid().nullable().optional(), ...targetFields })
  .refine(osMatchesEnvironment, osRule);
export type DeploymentUpdate = z.infer<typeof deploymentUpdateSchema>;

export const deploymentListQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  clientId: z.uuid().optional(),
  lifecycle: z.enum(DEPLOYMENT_LIFECYCLE_STATES).optional(),
  health: z.enum(HEALTH_STATES).optional(),
  environment: z.enum(TARGET_ENVIRONMENTS.map((t) => t.key) as [TargetEnvironment, ...TargetEnvironment[]]).optional(),
  sort: z
    .string()
    .regex(/^(code|client|lifecycle|health|createdAt|updatedAt):(asc|desc)$/)
    .optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type DeploymentListQuery = z.infer<typeof deploymentListQuerySchema>;

export const packageGenerateSchema = z.strictObject({
  tokenValidityHours: z
    .number({ error: 'Choose a token validity of 1, 4, 24 or 72 hours.' })
    .refine((v) => (TOKEN_VALIDITY_HOURS as readonly number[]).includes(v), 'Choose a token validity of 1, 4, 24 or 72 hours.')
    .default(24),
  /** Required when a usable package already exists: it will be superseded and its token revoked. */
  replaceExisting: z.boolean().default(false),
});
export type PackageGenerate = z.infer<typeof packageGenerateSchema>;

export const packageRevokeSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(200),
});

export interface ReadinessCheck {
  key: 'client' | 'license' | 'psa_instance' | 'psa_config' | 'services' | 'service_config' | 'psa_services' | 'target' | 'state' | 'record';
  label: string;
  ok: boolean;
  detail: string;
}

export interface PackageFileDto {
  path: string;
  size: number;
  sha256: string;
  /** True for the file that carries the single-use enrollment token. */
  containsToken: boolean;
}

export interface DeploymentPackageDto {
  id: string;
  number: number;
  status: PackageStatus;
  installationId: string;
  image: { repository: string; version: string; digest: string | null };
  target: { environment: string; os: string; arch: string };
  sha256: string;
  sizeBytes: number;
  fileName: string;
  files: PackageFileDto[];
  generatedAt: string;
  generatedBy: string | null;
  downloadCount: number;
  firstDownloadedAt: string | null;
  lastDownloadedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  token: { prefix: string; issuedAt: string; expiresAt: string; status: EnrollmentTokenStatus };
  /** The archive is held (encrypted) only while the package is usable. */
  downloadable: boolean;
}

export interface DeploymentSummary {
  id: string;
  code: string;
  client: { id: string; code: string; displayName: string };
  psaInstance: { id: string; code: string; displayName: string; providerKey: PsaProviderKey; providerName: string } | null;
  targetEnvironment: TargetEnvironment;
  targetOs: string | null;
  targetArch: string | null;
  hostLabel: string | null;
  lifecycleState: DeploymentLifecycleState;
  healthState: HealthState;
  healthReason: string | null;
  imageVersion: string | null;
  activePackage: { number: number; status: PackageStatus; tokenExpiresAt: string } | null;
  lastHeartbeatAt: string | null;
  /** The license the deployment runs under (Module 14); null for records created before licensing. */
  license: { id: string; code: string; status: LicenseStatus; endsAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
  isSynthetic: boolean;
}

export interface DeploymentDetail extends DeploymentSummary {
  /** Full license information and the current suspension, when suspended (Module 14). */
  licenseDetail: DeploymentLicenseInfo | null;
  suspension: DeploymentSuspension | null;
  /** Set once the deployment is decommissioned (Module 15): why, by whom, what was retired, and the metadata retention. */
  decommission: DeploymentDecommissionInfo | null;
  /** Module 16: the appliance's last reported verification of its license token (null until it reports). */
  applianceLicense: ApplianceLicenseStatus | null;
  /** Active licenses of the client the deployment could be bound to (settings). */
  licenseOptions: { id: string; code: string; displayName: string; status: LicenseStatus; endsAt: string | null; deploymentsUsed: number; maxDeployments: number }[];
  installationId: string | null;
  imageDigest: string | null;
  agentVersion: string | null;
  packageGeneratedAt: string | null;
  packageDownloadedAt: string | null;
  enrolledAt: string | null;
  verifiedAt: string | null;
  psaInstanceDetail: {
    id: string; code: string; displayName: string; providerKey: PsaProviderKey; providerName: string;
    status: 'active' | 'disabled'; apiEndpoint: string | null; connectionStatus: string; credentialStatus: string;
  } | null;
  services: { id: string; key: string; name: string; enabledOnPsa: boolean; requiresPsa: boolean; configComplete: boolean }[];
  /** Other active PSA instances of the same client (for settings). */
  psaOptions: { id: string; code: string; displayName: string; providerName: string }[];
  currentPackage: DeploymentPackageDto | null;
  packages: DeploymentPackageDto[];
  readiness: ReadinessCheck[];
  /** The edge image the next package will reference. */
  edgeImage: { repository: string; version: string; digest: string | null };
  agentGatewayUrl: string;
  /** Machine certificates of this deployment's agent, newest first. */
  agentCertificates: AgentCertificateDto[];
  createdBy: string | null;
  version: string;
}

export type DeploymentStats = Record<DeploymentLifecycleState, number> & { total: number };

/**
 * config/edge.json inside a package (schema version 1): the non-secret configuration the PSA Edge
 * appliance reads at start-up. Secrets are generated on the host by the install script; the enrollment
 * token lives in enrollment/enrollment.json.
 */
export interface EdgeConfigV1 {
  schemaVersion: 1;
  deployment: { id: string; code: string; installationId: string; packageNumber: number; generatedAt: string };
  client: { id: string; code: string; displayName: string };
  psa: {
    instanceId: string;
    instanceCode: string;
    provider: PsaProviderKey;
    displayName: string;
    authMethod: string | null;
    apiEndpoint: string | null;
    config: Record<string, string | number | boolean>;
    /** Names of the credentials to enter in the local admin UI; never values. */
    credentialFields: { key: string; label: string; secret: boolean }[];
  };
  /** `settings`: the client's non-secret values for the service's configuration requirements (catalog, Module 4). */
  services: { key: string; name: string; usesPsa: boolean; settings: Record<string, string | number | boolean> }[];
  controlPlane: {
    agentGatewayUrl: string;
    heartbeatIntervalSeconds: number;
    /** The only report types the agent may send (ARCHITECTURE §1.1.3). */
    reports: readonly string[];
  };
  image: { repository: string; version: string; digest: string | null };
  target: { environment: string; os: string; arch: string; hostLabel: string | null };
  /** The license the deployment runs under (Module 14): an identifier for the appliance, never an entitlement check it enforces itself. */
  license: { id: string; code: string; displayName: string; endsAt: string | null } | null;
}

/** The only report types the agent may send; their schemas are in health.ts. */
export const EDGE_REPORT_TYPES = ['database', 'database_schema', 'host_resources', 'containers', 'psa_integration_status', 'ticket_processing_metrics', 'synchronization', 'versions', 'backup', 'certificates_security'] as const;

/** The standard PSA Edge image as configured for this Control Plane, and where it is in use. */
export interface EdgeImageInfo {
  repository: string;
  version: string;
  /** Signed registry digest; null until an image is published to a registry (OPS-REGISTRY). */
  digest: string | null;
  entrypoints: { name: string; purpose: string }[];
  usage: { version: string | null; deployments: number; synthetic: number }[];
}

export type AgentCertificateStatus = 'active' | 'superseded' | 'revoked';

/** An agent machine certificate (public metadata only). */
export interface AgentCertificateDto {
  id: string;
  serial: string;
  /** SHA-256 of the certificate (hex). */
  fingerprint: string;
  subject: string;
  installationId: string;
  status: AgentCertificateStatus;
  issuedVia: 'enrollment' | 'renewal';
  issuedAt: string;
  notBefore: string;
  notAfter: string;
  lastSeenAt: string | null;
  agentVersion: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export const agentCertificateRevokeSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(200),
});
