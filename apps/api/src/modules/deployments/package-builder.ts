import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EDGE_REPORT_TYPES, type EdgeConfigV1, type PackageFileDto, type PsaProviderKey } from '@psacc/contracts';
import { zipSync, type Zippable } from 'fflate';

/**
 * Builds a client-specific deployment package: Compose configuration, appliance configuration,
 * single-use enrollment token, install/verify scripts and documentation, as one ZIP.
 *
 * The package references the standard PSA Edge image; it never contains an image or a permanent
 * secret. Pure function of its input (no I/O except reading the bundled templates).
 */

export interface PackageInput {
  deployment: {
    id: string;
    code: string;
    targetEnvironment: string;
    targetEnvironmentLabel: string;
    targetOs: string;
    targetArch: string;
    hostLabel: string | null;
  };
  client: { id: string; code: string; displayName: string };
  license: { id: string; code: string; displayName: string; endsAt: string | null } | null;
  psa: {
    instanceId: string;
    code: string;
    displayName: string;
    providerKey: PsaProviderKey;
    providerName: string;
    authMethod: string | null;
    apiEndpoint: string | null;
    config: Record<string, string | number | boolean>;
    credentialFields: { key: string; label: string; secret: boolean }[];
  };
  services: { key: string; name: string; usesPsa: boolean; settings: Record<string, string | number | boolean> }[];
  packageNumber: number;
  installationId: string;
  generatedAt: Date;
  generatedBy: string;
  image: { repository: string; version: string; digest: string | null };
  agentGatewayUrl: string;
  /** The platform CA the agent pins when it first contacts the gateway (public). */
  ca: { pem: string; fingerprint: string };
  heartbeatSeconds: number;
  token: string;
  tokenExpiresAt: Date;
}

export interface BuiltPackage {
  archive: Buffer;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  rootFolder: string;
  files: PackageFileDto[];
  config: EdgeConfigV1;
}

/** Tables the edge database must contain after migrations (ARCHITECTURE §3.2). */
export const EDGE_REQUIRED_TABLES = [
  'app_metadata', 'psa_connections', 'service_configurations', 'helpdesk_tickets', 'ticket_events', 'sync_runs',
  'audit_events', 'schema_migrations', 'credential_store', 'integration_logs', 'backup_runs', 'local_admin_users',
] as const;

const TEMPLATE_DIR = new URL('../../../templates/edge-package/', import.meta.url);
const TEMPLATES = [
  'compose.yaml', 'compose.production.yaml', 'edge.env.template', 'install.sh', 'install.ps1', 'verify.sh', 'verify.ps1', 'upgrade.sh', 'upgrade.ps1', 'uninstall.sh', 'uninstall.ps1', 'edge-backup.sh',
  'README.md', 'INSTALL.md', 'UNINSTALL.md',
] as const;
type TemplateName = (typeof TEMPLATES)[number];
let cache: Map<TemplateName, string> | null = null;

function template(name: TemplateName): string {
  if (!cache) cache = new Map(TEMPLATES.map((t) => [t, readFileSync(new URL(`${t}.tmpl`, TEMPLATE_DIR), 'utf8').replace(/\r\n/g, '\n')]));
  return cache.get(name)!;
}

/** Replaces {{name}} placeholders. Go-template expressions such as {{.ExitCode}} are left alone. */
export function render(tmpl: string, vars: Record<string, string | number>): string {
  return tmpl.replace(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`Package template variable "${key}" is not defined`);
    return String(vars[key]);
  });
}

/** Single line of plain text, safe in YAML/shell comments and Markdown table cells. */
export function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\|/g, '/').trim();
}

const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Deterministic local admin port per deployment so several appliances can share a test host. */
export function localAdminPort(deploymentCode: string): number {
  const n = Number(deploymentCode.replace(/\D/g, '')) || 0;
  return 18000 + (n % 1000);
}

export function buildPackage(input: PackageInput): BuiltPackage {
  const code = input.deployment.code;
  const slug = code.toLowerCase();
  const rootFolder = `psacc-${slug}`;
  const fileName = `psacc-${slug}-package-${input.packageNumber}.zip`;
  const generatedAt = input.generatedAt.toISOString();
  const tokenExpiresAt = input.tokenExpiresAt.toISOString();
  const { repository, version, digest } = input.image;
  const edgeImageDefault = digest ? `${repository}:${version}@${digest}` : `${repository}:${version}`;
  const port = localAdminPort(code);

  const config: EdgeConfigV1 = {
    schemaVersion: 1,
    deployment: { id: input.deployment.id, code, installationId: input.installationId, packageNumber: input.packageNumber, generatedAt },
    client: { id: input.client.id, code: input.client.code, displayName: input.client.displayName },
    psa: {
      instanceId: input.psa.instanceId,
      instanceCode: input.psa.code,
      provider: input.psa.providerKey,
      displayName: input.psa.displayName,
      authMethod: input.psa.authMethod,
      apiEndpoint: input.psa.apiEndpoint,
      config: input.psa.config,
      credentialFields: input.psa.credentialFields,
    },
    services: input.services,
    controlPlane: { agentGatewayUrl: input.agentGatewayUrl, heartbeatIntervalSeconds: input.heartbeatSeconds, reports: EDGE_REPORT_TYPES },
    image: { repository, version, digest },
    license: input.license,
    target: {
      environment: input.deployment.targetEnvironment,
      os: input.deployment.targetOs,
      arch: input.deployment.targetArch,
      hostLabel: input.deployment.hostLabel,
    },
  };

  const enrollment = {
    schemaVersion: 1,
    deploymentId: input.deployment.id,
    deploymentCode: code,
    installationId: input.installationId,
    agentGatewayUrl: input.agentGatewayUrl,
    caCertificate: input.ca.pem,
    caFingerprint: input.ca.fingerprint,
    token: input.token,
    expiresAt: tokenExpiresAt,
    note: 'Single-use enrollment token. It stops working after the first successful enrollment or at expiresAt.',
  };

  const vars: Record<string, string | number> = {
    deploymentCode: code,
    deploymentId: input.deployment.id,
    installationId: input.installationId,
    packageNumber: input.packageNumber,
    generatedAt,
    generatedBy: oneLine(input.generatedBy),
    clientName: oneLine(input.client.displayName),
    clientCode: input.client.code,
    clientComment: oneLine(`${input.client.displayName} (${input.client.code})`),
    projectName: rootFolder,
    edgeImageDefault,
    edgeImageRef: edgeImageDefault,
    prodEdgeImageExpr: digest
      ? `\${PSA_EDGE_IMAGE:-${edgeImageDefault}}`
      : `\${PSA_EDGE_IMAGE:?Set PSA_EDGE_IMAGE to the signed PSA Edge image pinned by digest, for example ${repository}@sha256:<digest>}`,
    localAdminPort: port,
    psaProviderName: oneLine(input.psa.providerName),
    psaDisplayName: oneLine(input.psa.displayName),
    psaCode: input.psa.code,
    psaEndpoint: input.psa.apiEndpoint ?? 'the PSA API endpoint',
    servicesList: oneLine(input.services.map((s) => s.name).join(', ') || 'none'),
    credentialFieldsList: input.psa.credentialFields.length
      ? input.psa.credentialFields.map((f) => `- ${oneLine(f.label)}${f.secret ? ' (secret)' : ''}`).join('\n')
      : '- (none required by this authentication method)',
    targetEnvironmentLabel: oneLine(input.deployment.targetEnvironmentLabel),
    targetOs: input.deployment.targetOs,
    targetArch: input.deployment.targetArch,
    hostLabelSuffix: input.deployment.hostLabel ? ` · host "${oneLine(input.deployment.hostLabel)}"` : '',
    tokenExpiresAt,
    agentGatewayUrl: input.agentGatewayUrl,
    archiveName: fileName,
    rootFolder,
    minTableCount: EDGE_REQUIRED_TABLES.length,
  };

  // path → [content, unix mode, carries the enrollment token]
  const entries: [string, string, number, boolean][] = [
    ['README.md', render(template('README.md'), vars), 0o644, false],
    ['INSTALL.md', render(template('INSTALL.md'), vars), 0o644, false],
    ['UNINSTALL.md', render(template('UNINSTALL.md'), vars), 0o644, false],
    ['compose.yaml', render(template('compose.yaml'), vars), 0o644, false],
    ['compose.production.yaml', render(template('compose.production.yaml'), vars), 0o644, false],
    ['config/edge.json', `${JSON.stringify(config, null, 2)}\n`, 0o644, false],
    ['config/edge.env.template', render(template('edge.env.template'), vars), 0o644, false],
    ['enrollment/enrollment.json', `${JSON.stringify(enrollment, null, 2)}\n`, 0o600, true],
    ['scripts/install.sh', render(template('install.sh'), vars), 0o755, false],
    ['scripts/verify.sh', render(template('verify.sh'), vars), 0o755, false],
    ['scripts/edge-backup.sh', render(template('edge-backup.sh'), vars), 0o755, false],
    ['scripts/install.ps1', render(template('install.ps1'), vars), 0o644, false],
    ['scripts/verify.ps1', render(template('verify.ps1'), vars), 0o644, false],
    ['scripts/upgrade.sh', render(template('upgrade.sh'), vars), 0o755, false],
    ['scripts/upgrade.ps1', render(template('upgrade.ps1'), vars), 0o644, false],
    ['scripts/uninstall.sh', render(template('uninstall.sh'), vars), 0o755, false],
    ['scripts/uninstall.ps1', render(template('uninstall.ps1'), vars), 0o644, false],
  ];

  const bytes = (path: string, text: string) =>
    path.endsWith('.ps1')
      // Windows PowerShell 5.1 needs a BOM to read UTF-8, and CRLF line endings.
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8')])
      : Buffer.from(text, 'utf8');

  const contents = entries.map(([path, text, mode, containsToken]) => ({ path, data: bytes(path, text), mode, containsToken }));
  const manifest = {
    schemaVersion: 1,
    deployment: { id: input.deployment.id, code },
    client: { code: input.client.code },
    packageNumber: input.packageNumber,
    installationId: input.installationId,
    generatedAt,
    image: { repository, version, digest },
    files: contents.map((c) => ({ path: c.path, size: c.data.length, sha256: sha256Hex(c.data) })),
  };
  contents.push({ path: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o644, containsToken: false });
  const checksums = contents.map((c) => `${sha256Hex(c.data)}  ${c.path}`).join('\n') + '\n';
  contents.push({ path: 'CHECKSUMS.sha256', data: Buffer.from(checksums), mode: 0o644, containsToken: false });

  const zippable: Zippable = {};
  for (const c of contents) {
    zippable[`${rootFolder}/${c.path}`] = [new Uint8Array(c.data), { level: 9, mtime: input.generatedAt, os: 3, attrs: (0o100000 | c.mode) << 16 }];
  }
  const archive = Buffer.from(zipSync(zippable));

  return {
    archive,
    sha256: sha256Hex(archive),
    sizeBytes: archive.length,
    fileName,
    rootFolder,
    files: contents.map((c) => ({ path: c.path, size: c.data.length, sha256: sha256Hex(c.data), containsToken: c.containsToken })),
    config,
  };
}
