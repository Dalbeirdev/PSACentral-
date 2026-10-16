import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  type AgentCertificateDto,
  type AuditEventDto,
  type AuditOutcome,
  type DeploymentCreate,
  type DeploymentDecommission,
  type DecommissionIdentitySummary,
  type DeploymentDetail,
  type DeploymentRemovalResult,
  COMMAND_OPEN_STATUSES,
  type DeploymentLifecycleState,
  type DeploymentListQuery,
  type DeploymentPackageDto,
  type DeploymentStats,
  type DeploymentSummary,
  type DeploymentUpdate,
  type EdgeImageInfo,
  DEPLOYMENT_LIFECYCLE_STATES,
  type EnrollmentTokenStatus,
  type PackageGenerate,
  type PackageStatus,
  PRE_ENROLLMENT_STATES,
  type PsaProviderKey,
  type ReadinessCheck,
  TARGET_ENVIRONMENTS,
  type TargetEnvironment,
  type Paged,
  checkServiceConfig,
  type ConfigRequirement,
} from '@psacc/contracts';
import type { LicenseStatus } from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { randomToken, SecretBox, sha256 } from '../../common/crypto.js';
import { JsonLogger } from '../../common/logger.js';
import { AppError } from '../../common/problem.filter.js';
import { ValidationFailedException } from '../../common/zod.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService, escapeLike } from '../audit/audit.service.js';
import { PsaAdapterRegistry } from '../psa/adapters/registry.js';
import { PkiService } from '../agents/pki.service.js';
import { CommandsService } from './commands.service.js';
import { daysRemaining, LicensesService } from './licenses.service.js';
import { RetentionService } from './retention.service.js';
import { buildPackage } from './package-builder.js';

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : null);
const VERSION_SQL = `(extract(epoch FROM d.updated_at) * 1000000)::bigint::text`;
const ENV_LABEL = Object.fromEntries(TARGET_ENVIRONMENTS.map((t) => [t.key, t.label])) as Record<string, string>;
const TOKEN_PREFIX = 'psacc_enr_';

const SORT: Record<string, string> = {
  code: 'd.code',
  client: 'c.display_name',
  lifecycle: `array_position(ARRAY[${DEPLOYMENT_LIFECYCLE_STATES.map((s) => `'${s}'`).join(',')}]::text[], d.lifecycle_state)`,
  health: `array_position(ARRAY['critical','offline','degraded','unknown','healthy']::text[], d.health_state)`,
  createdAt: 'd.created_at',
  updatedAt: 'd.updated_at',
};

const FROM = `
  FROM deployments d
  JOIN clients c ON c.id = d.client_id
  LEFT JOIN psa_instances i ON i.id = d.psa_instance_id
  LEFT JOIN psa_providers p ON p.key = i.provider_key
  LEFT JOIN deployment_packages ap ON ap.deployment_id = d.id AND ap.status = 'active'
  LEFT JOIN enrollment_tokens apt ON apt.package_id = ap.id
  LEFT JOIN licenses l ON l.id = d.license_id`;

const SELECT = `
  SELECT d.*, ${VERSION_SQL} AS version, c.code AS client_code, c.display_name AS client_name, c.status AS client_status,
         i.code AS psa_code, i.display_name AS psa_name, i.provider_key, p.name AS provider_name, i.status AS psa_status,
         i.api_endpoint AS psa_endpoint, i.auth_method AS psa_auth_method, i.config AS psa_config,
         i.connection_status AS psa_connection_status, i.credential_status AS psa_credential_status,
         ap.package_number AS ap_number, ap.status AS ap_status, apt.expires_at AS ap_expires,
         l.code AS license_code, l.status AS license_status, l.ends_at AS license_ends, l.display_name AS license_name, l.max_deployments AS license_max,
         (SELECT count(*)::int FROM deployments x WHERE x.license_id = l.id AND x.lifecycle_state <> 'decommissioned') AS license_used
  ${FROM}`;

function toSummary(r: Row): DeploymentSummary {
  return {
    id: r.id as string,
    code: r.code as string,
    client: { id: r.client_id as string, code: r.client_code as string, displayName: r.client_name as string },
    psaInstance: r.psa_instance_id
      ? { id: r.psa_instance_id as string, code: r.psa_code as string, displayName: r.psa_name as string, providerKey: r.provider_key as PsaProviderKey, providerName: r.provider_name as string }
      : null,
    targetEnvironment: r.target_environment as TargetEnvironment,
    targetOs: (r.target_os as string | null) ?? null,
    targetArch: (r.target_arch as string | null) ?? null,
    hostLabel: (r.host_label as string | null) ?? null,
    lifecycleState: r.lifecycle_state as DeploymentLifecycleState,
    healthState: r.health_state as DeploymentSummary['healthState'],
    healthReason: (r.health_reason as string | null) ?? null,
    imageVersion: (r.image_version as string | null) ?? null,
    activePackage: r.ap_number ? { number: r.ap_number as number, status: r.ap_status as PackageStatus, tokenExpiresAt: iso(r.ap_expires)! } : null,
    lastHeartbeatAt: iso(r.last_heartbeat_at),
    license: r.license_code ? { id: r.license_id as string, code: r.license_code as string, status: r.license_status as LicenseStatus, endsAt: ymd(r.license_ends) } : null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    isSynthetic: r.is_synthetic as boolean,
  };
}

function tokenStatus(r: Row, now: Date): EnrollmentTokenStatus {
  if (r.t_consumed_at) return 'consumed';
  if (r.t_revoked_at) return 'revoked';
  return (r.t_expires_at as Date) <= now ? 'expired' : 'active';
}

function toPackage(r: Row, deploymentCode: string, now: Date): DeploymentPackageDto {
  return {
    id: r.id as string,
    number: r.package_number as number,
    status: r.status as PackageStatus,
    installationId: r.installation_id as string,
    image: { repository: r.image_repository as string, version: r.image_version as string, digest: (r.image_digest as string | null) ?? null },
    target: { environment: r.target_environment as string, os: r.target_os as string, arch: r.target_arch as string },
    sha256: r.sha256 as string,
    sizeBytes: r.size_bytes as number,
    fileName: `psacc-${deploymentCode.toLowerCase()}-package-${r.package_number}.zip`,
    files: r.manifest as DeploymentPackageDto['files'],
    generatedAt: iso(r.generated_at)!,
    generatedBy: (r.generated_by_name as string | null) ?? null,
    downloadCount: r.download_count as number,
    firstDownloadedAt: iso(r.first_downloaded_at),
    lastDownloadedAt: iso(r.last_downloaded_at),
    revokedAt: iso(r.revoked_at),
    revokeReason: (r.revoke_reason as string | null) ?? null,
    token: { prefix: `${r.t_prefix as string}…`, issuedAt: iso(r.t_issued_at)!, expiresAt: iso(r.t_expires_at)!, status: tokenStatus(r, now) },
    downloadable: r.status === 'active' && r.has_archive === true,
  };
}

const PACKAGE_SELECT = `
  SELECT pk.id, pk.package_number, pk.status, pk.installation_id, pk.image_repository, pk.image_version, pk.image_digest,
         pk.target_environment, pk.target_os, pk.target_arch, pk.manifest, pk.size_bytes, pk.sha256, pk.generated_at,
         pk.download_count, pk.first_downloaded_at, pk.last_downloaded_at, pk.revoked_at, pk.revoke_reason,
         (pk.archive_ciphertext IS NOT NULL) AS has_archive, u.display_name AS generated_by_name,
         t.token_prefix AS t_prefix, t.issued_at AS t_issued_at, t.expires_at AS t_expires_at,
         t.consumed_at AS t_consumed_at, t.revoked_at AS t_revoked_at
  FROM deployment_packages pk
  JOIN enrollment_tokens t ON t.package_id = pk.id
  LEFT JOIN users u ON u.id = pk.generated_by`;

const isPreEnrollment = (s: unknown) => (PRE_ENROLLMENT_STATES as readonly string[]).includes(s as string);

/** A license's status as it applies today: an active license past its end date counts as expired until the sweep records it. */
function licenseEffectiveStatus(r: Row): string | null {
  if (!r.license_code) return null;
  const ends = ymd(r.license_ends);
  if (r.license_status === 'active' && ends && ends < new Date().toISOString().slice(0, 10)) return 'expired';
  return r.license_status as string;
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class DeploymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly box: SecretBox;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PsaAdapterRegistry) private readonly adapters: PsaAdapterRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject(PkiService) private readonly pki: PkiService,
    @Inject(CommandsService) private readonly commands: CommandsService,
  ) {
    this.box = new SecretBox(config.secrets.dataEncryptionKey);
  }

  /** Token-bearing archives must not outlive their token: sweep expired packages every few minutes. */
  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      this.sweepExpired()
        .then((n) => n && this.logger.log({ msg: 'Expired deployment packages purged', count: n }, 'DeploymentsService'))
        .catch((err) => this.logger.warn({ msg: 'Package expiry sweep failed', err }, 'DeploymentsService'));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Marks packages with expired tokens and purges their archives (this organization only). */
  private async expireStale(q: Queryable, orgId: string) {
    await q.query('SELECT app_expire_deployment_packages($1)', [orgId]);
  }

  /** Cross-organization sweep, run periodically by the API process. */
  async sweepExpired(): Promise<number> {
    const r = await this.db.unscoped((q) => q.one<{ n: number }>('SELECT app_expire_deployment_packages() AS n'));
    return r.n;
  }

  private async actor(q: Queryable, auth: AuthContext) {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  async list(auth: AuthContext, query: DeploymentListQuery): Promise<Paged<DeploymentSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (query.q) {
      const like = p(`%${escapeLike(query.q)}%`);
      where.push(`(d.code ILIKE ${like} OR c.display_name ILIKE ${like} OR c.code ILIKE ${like} OR coalesce(d.host_label, '') ILIKE ${like} OR coalesce(i.code, '') ILIKE ${like})`);
    }
    if (query.clientId) where.push(`d.client_id = ${p(query.clientId)}`);
    if (query.lifecycle) where.push(`d.lifecycle_state = ${p(query.lifecycle)}`);
    if (query.health) where.push(`d.health_state = ${p(query.health)}`);
    if (query.environment) where.push(`d.target_environment = ${p(query.environment)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [field, dir] = (query.sort ?? 'code:desc').split(':') as [string, string];
    const order = `${SORT[field] ?? 'd.code'} ${dir === 'desc' ? 'DESC' : 'ASC'}, d.id`;
    return this.db.tenant(auth, async (q) => {
      await this.expireStale(q, auth.orgId);
      const total = await q.one<{ n: number }>(`SELECT count(*)::int AS n ${FROM} ${whereSql}`, params);
      const rows = await q.query<Row>(`${SELECT} ${whereSql} ORDER BY ${order} LIMIT ${p(query.pageSize)} OFFSET ${p((query.page - 1) * query.pageSize)}`, params);
      return { items: rows.map(toSummary), page: query.page, pageSize: query.pageSize, total: total.n };
    });
  }

  async stats(auth: AuthContext): Promise<DeploymentStats> {
    return this.db.tenant(auth, async (q) => {
      await this.expireStale(q, auth.orgId);
      const rows = await q.query<{ s: DeploymentLifecycleState; n: number }>('SELECT lifecycle_state AS s, count(*)::int AS n FROM deployments GROUP BY 1');
      const out = Object.fromEntries(DEPLOYMENT_LIFECYCLE_STATES.map((s) => [s, 0])) as DeploymentStats;
      out.total = 0;
      for (const r of rows) {
        out[r.s] = r.n;
        out.total += r.n;
      }
      return out;
    });
  }

  private async require(q: Queryable, id: string, lock = false): Promise<Row> {
    const r = await q.maybeOne<Row>(`${SELECT} WHERE d.id = $1 ${lock ? 'FOR UPDATE OF d' : ''}`, [id]);
    if (!r) throw new AppError(404, 'not-found', 'Deployment not found.');
    return r;
  }

  /** Services the appliance will run: client services that need no PSA, plus those enabled on this deployment's PSA instance. */
  private async servicesFor(q: Queryable, r: Row) {
    const rows = await q.query<Row>(
      `SELECT s.id, s.key, s.name, s.requires_psa, s.config_requirements, cs.config,
              EXISTS (SELECT 1 FROM psa_instance_services pis WHERE pis.psa_instance_id = $2 AND pis.service_id = s.id) AS on_psa
       FROM client_services cs JOIN services s ON s.id = cs.service_id
       WHERE cs.client_id = $1 ORDER BY s.sort_order`,
      [r.client_id, r.psa_instance_id ?? null],
    );
    return rows.map((s) => {
      const checked = checkServiceConfig((s.config_requirements as ConfigRequirement[]) ?? [], s.config as Record<string, unknown>);
      return {
        id: s.id as string, key: s.key as string, name: s.name as string, requiresPsa: s.requires_psa as boolean, enabledOnPsa: s.on_psa as boolean,
        configComplete: checked.issues.length === 0, settings: checked.config,
      };
    });
  }

  private readiness(r: Row, services: Awaited<ReturnType<DeploymentsService['servicesFor']>>): ReadinessCheck[] {
    const checks: ReadinessCheck[] = [];
    const add = (key: ReadinessCheck['key'], label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail });

    add('record', 'Real deployment record', !r.is_synthetic, r.is_synthetic ? 'Synthetic sample records cannot receive real packages.' : 'Created in this platform.');
    add(
      'state', 'Not yet enrolled', isPreEnrollment(r.lifecycle_state),
      isPreEnrollment(r.lifecycle_state) ? 'A package can be generated until the agent enrolls.' : `The deployment is ${r.lifecycle_state}; packages can no longer be generated.`,
    );
    const clientOk = !['suspended', 'offboarded'].includes(r.client_status as string);
    add('client', 'Client can receive deployments', clientOk, clientOk ? `${r.client_name} (${r.client_code}) is ${r.client_status}.` : `The client is ${r.client_status}.`);

    const licenseStatus = licenseEffectiveStatus(r);
    const licenseOk = licenseStatus === 'active' && (r.license_used as number) <= (r.license_max as number);
    add('license', 'Active license with capacity', licenseOk,
      !r.license_code ? 'No license is assigned. Create one for the client on the Licenses page and assign it in Settings.'
        : licenseStatus !== 'active' ? `${r.license_code} is ${licenseStatus}.`
        : licenseOk ? `${r.license_code} · ${r.license_name} · ${r.license_used} of ${r.license_max} deployment(s).`
        : `${r.license_code} allows ${r.license_max} deployment(s); ${r.license_used} are bound to it.`);

    const psaOk = !!r.psa_instance_id && r.psa_status === 'active';
    add('psa_instance', 'PSA instance assigned and active', psaOk,
      !r.psa_instance_id ? 'Choose a PSA instance in Settings.' : psaOk ? `${r.psa_code} · ${r.provider_name}.` : `${r.psa_code} is disabled. Choose another instance in Settings.`);

    let cfgOk = false;
    let cfgDetail = 'Needs an active PSA instance first.';
    if (psaOk) {
      const parsed = this.adapters.get(r.provider_key as string).parseConfig(r.psa_config ?? {}, (r.psa_auth_method as string | null) ?? '');
      cfgOk = parsed.ok && parsed.endpoint === r.psa_endpoint;
      cfgDetail = parsed.ok
        ? cfgOk ? `Validated by the ${r.provider_name} adapter: ${parsed.endpoint}` : 'The stored endpoint is out of date. Open and save the PSA configuration.'
        : `The ${r.provider_name} adapter reports: ${parsed.issues[0]!.message}`;
    }
    add('psa_config', 'PSA configuration valid', cfgOk, cfgDetail);

    add('services', 'Services assigned', services.length > 0, services.length ? `${services.length} service(s) assigned to the client.` : 'Assign at least one service to the client.');
    const incomplete = services.filter((s) => !s.configComplete);
    add('service_config', 'Service settings complete', incomplete.length === 0,
      incomplete.length ? `${incomplete.map((s) => s.name).join(', ')}: required settings are missing. Complete them on the client's Services page.` : 'Every assigned service has the settings its catalog entry requires.');
    const onPsa = services.filter((s) => s.enabledOnPsa);
    add('psa_services', 'Services enabled on the PSA instance', onPsa.length > 0,
      onPsa.length ? `${onPsa.map((s) => s.name).join(', ')} run through ${r.psa_code}.` : `No client service is enabled on ${r.psa_code ?? 'the PSA instance'}. Enable one on the PSA instance page.`);

    const fixedOs = TARGET_ENVIRONMENTS.find((t) => t.key === r.target_environment)?.os;
    const targetOk = !!r.target_os && !!r.target_arch && (!fixedOs || fixedOs === r.target_os);
    add('target', 'Target platform complete', targetOk,
      targetOk ? `${ENV_LABEL[r.target_environment as string]} · ${r.target_os} / ${r.target_arch}` : 'Set the operating system and architecture in Settings.');
    return checks;
  }

  private async detailIn(q: Queryable, id: string): Promise<DeploymentDetail> {
    const r = await this.require(q, id);
    const now = new Date();
    const services = await this.servicesFor(q, r);
    const pkgs = (await q.query<Row>(`${PACKAGE_SELECT} WHERE pk.deployment_id = $1 ORDER BY pk.package_number DESC`, [id])).map((p) => toPackage(p, r.code as string, now));
    const psaOptions = await q.query<Row>(
      `SELECT i.id, i.code, i.display_name, p.name AS provider_name FROM psa_instances i JOIN psa_providers p ON p.key = i.provider_key
       WHERE i.client_id = $1 AND i.status = 'active' ORDER BY i.code`,
      [r.client_id],
    );
    const creator = r.created_by ? await q.maybeOne<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [r.created_by]) : null;
    const licenseOptions = await q.query<Row>(
      `SELECT l.id, l.code, l.display_name, l.status, l.ends_at, l.max_deployments,
              (SELECT count(*)::int FROM deployments x WHERE x.license_id = l.id AND x.lifecycle_state <> 'decommissioned') AS used
       FROM licenses l WHERE l.client_id = $1 AND l.status = 'active' ORDER BY l.ends_at DESC NULLS FIRST, l.code`,
      [r.client_id],
    );
    const suspendedBy = r.lifecycle_state === 'suspended'
      ? ((await q.maybeOne<{ actor_display: string }>(
          `SELECT actor_display FROM audit_events WHERE action = 'deployment.suspended' AND target_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [id],
        ))?.actor_display ?? null)
      : null;
    // Module 15: who decommissioned it and how long its metadata is retained.
    const decommissionedBy = r.decommissioned_by
      ? ((await q.maybeOne<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [r.decommissioned_by]))?.display_name ?? null)
      : null;
    const retentionDays = r.lifecycle_state === 'decommissioned' ? await RetentionService.daysIn(q, r.organization_id as string) : 0;
    const certs = await q.query<Row>(
      `SELECT id, serial, encode(fingerprint, 'hex') AS fp, subject, installation_id, status, issued_via, issued_at, not_before, not_after,
              last_seen_at, agent_version, revoked_at, revoke_reason
       FROM agent_certificates WHERE deployment_id = $1 ORDER BY issued_at DESC`,
      [id],
    );
    const { imageRepository, imageVersion, imageDigest, agentGatewayUrl } = this.config.edge;
    return {
      ...toSummary(r),
      installationId: (r.installation_id as string | null) ?? null,
      imageDigest: (r.image_digest as string | null) ?? null,
      agentVersion: (r.agent_version as string | null) ?? null,
      packageGeneratedAt: iso(r.package_generated_at),
      packageDownloadedAt: iso(r.package_downloaded_at),
      enrolledAt: iso(r.enrolled_at),
      verifiedAt: iso(r.verified_at),
      psaInstanceDetail: r.psa_instance_id
        ? {
            id: r.psa_instance_id as string, code: r.psa_code as string, displayName: r.psa_name as string, providerKey: r.provider_key as PsaProviderKey,
            providerName: r.provider_name as string, status: r.psa_status as 'active' | 'disabled', apiEndpoint: (r.psa_endpoint as string | null) ?? null,
            connectionStatus: r.psa_connection_status as string, credentialStatus: r.psa_credential_status as string,
          }
        : null,
      services,
      psaOptions: psaOptions.map((o) => ({ id: o.id as string, code: o.code as string, displayName: o.display_name as string, providerName: o.provider_name as string })),
      currentPackage: pkgs.find((p) => p.status === 'active') ?? null,
      packages: pkgs,
      readiness: this.readiness(r, services),
      edgeImage: { repository: imageRepository, version: imageVersion, digest: imageDigest },
      agentGatewayUrl,
      agentCertificates: certs.map((c): AgentCertificateDto => ({
        id: c.id as string, serial: c.serial as string, fingerprint: c.fp as string, subject: c.subject as string, installationId: c.installation_id as string,
        status: c.status as AgentCertificateDto['status'], issuedVia: c.issued_via as AgentCertificateDto['issuedVia'], issuedAt: iso(c.issued_at)!,
        notBefore: iso(c.not_before)!, notAfter: iso(c.not_after)!, lastSeenAt: iso(c.last_seen_at), agentVersion: (c.agent_version as string | null) ?? null,
        revokedAt: iso(c.revoked_at), revokeReason: (c.revoke_reason as string | null) ?? null,
      })),
      createdBy: creator?.display_name ?? null,
      version: r.version as string,
      licenseDetail: r.license_code
        ? { id: r.license_id as string, code: r.license_code as string, displayName: r.license_name as string, status: licenseEffectiveStatus(r) as LicenseStatus, endsAt: ymd(r.license_ends), daysRemaining: daysRemaining(ymd(r.license_ends)) }
        : null,
      suspension: r.lifecycle_state === 'suspended'
        ? { at: iso(r.suspended_at)!, reason: (r.suspended_reason as string) ?? '', fromState: r.suspended_from_state as DeploymentLifecycleState, by: suspendedBy }
        : null,
      decommission: r.lifecycle_state === 'decommissioned'
        ? {
            at: iso(r.decommissioned_at)!, reason: r.decommissioned_reason as string, by: decommissionedBy, fromState: r.decommissioned_from_state as DeploymentLifecycleState,
            identity: (r.decommission_identity as DecommissionIdentitySummary | null) ?? { certificatesRevoked: 0, tokensRevoked: 0, packagesRevoked: 0, commandsCancelled: 0 },
            retainedUntil: new Date((r.decommissioned_at as Date).getTime() + retentionDays * 86_400_000).toISOString(), metadataPurgedAt: iso(r.metadata_purged_at),
          }
        : null,
      licenseOptions: licenseOptions.map((o) => ({
        id: o.id as string, code: o.code as string, displayName: o.display_name as string, status: o.status as LicenseStatus, endsAt: ymd(o.ends_at),
        deploymentsUsed: o.used as number, maxDeployments: o.max_deployments as number,
      })),
    };
  }

  async detail(auth: AuthContext, id: string): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      await this.expireStale(q, auth.orgId);
      return this.detailIn(q, id);
    });
  }

  private async assertPsaInstance(q: Queryable, clientId: string, psaInstanceId: string) {
    const inst = await q.maybeOne<{ client_id: string; status: string }>('SELECT client_id, status FROM psa_instances WHERE id = $1', [psaInstanceId]);
    if (!inst || inst.client_id !== clientId) throw new ValidationFailedException([{ path: 'psaInstanceId', message: 'Choose a PSA instance that belongs to this client.' }]);
    if (inst.status !== 'active') throw new ValidationFailedException([{ path: 'psaInstanceId', message: 'Disabled PSA instances cannot be used by deployments.' }]);
  }

  async create(auth: AuthContext, dto: DeploymentCreate, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      const client = await q.maybeOne<{ status: string; display_name: string }>('SELECT status, display_name FROM clients WHERE id = $1', [dto.clientId]);
      if (!client) throw new ValidationFailedException([{ path: 'clientId', message: 'Choose a client you have access to.' }]);
      if (['suspended', 'offboarded'].includes(client.status)) {
        throw new ValidationFailedException([{ path: 'clientId', message: `The client is ${client.status} and cannot get new deployments.` }]);
      }
      await this.assertPsaInstance(q, dto.clientId, dto.psaInstanceId);
      const licenseId = dto.licenseId ? await this.assertLicense(q, dto.clientId, dto.licenseId) : await LicensesService.defaultLicenseFor(q, dto.clientId);
      const id = randomUUID();
      await q.query(
        `INSERT INTO deployments (id, organization_id, client_id, psa_instance_id, code, target_environment, target_os, target_arch, host_label, created_by, license_id)
         VALUES ($1, $2, $3, $4, next_org_code('deployment', 'DEP'), $5, $6, $7, $8, $9, $10)`,
        [id, auth.orgId, dto.clientId, dto.psaInstanceId, dto.targetEnvironment, dto.targetOs, dto.targetArch, dto.hostLabel ?? null, auth.userId, licenseId],
      );
      const { code } = await q.one<{ code: string }>('SELECT code FROM deployments WHERE id = $1', [id]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.created', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: code, clientId: dto.clientId,
        metadata: { code, targetEnvironment: dto.targetEnvironment, targetOs: dto.targetOs, targetArch: dto.targetArch, lifecycleState: 'draft', licenseId },
      });
      return this.detailIn(q, id);
    });
  }

  async update(auth: AuthContext, id: string, dto: DeploymentUpdate, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      await this.expireStale(q, auth.orgId);
      const before = await this.require(q, id, true);
      if (before.version !== dto.version) {
        throw new AppError(409, 'stale-version', 'This deployment was changed by someone else after you opened it. Reload to see the latest version.');
      }
      if (before.is_synthetic) throw new AppError(409, 'synthetic-record', 'Synthetic sample records cannot be changed.');
      if (before.lifecycle_state !== 'draft') {
        throw new AppError(409, 'package-exists', 'Settings are locked while a package exists or after enrollment. Revoke the current package first; a new package is then generated from the new settings.');
      }
      await this.assertPsaInstance(q, before.client_id as string, dto.psaInstanceId);
      if (dto.licenseId) {
        await this.assertLicense(q, before.client_id as string, dto.licenseId);
        await q.query('UPDATE deployments SET license_id = $2 WHERE id = $1', [id, dto.licenseId]);
      }
      await q.query(
        `UPDATE deployments SET psa_instance_id = $2, target_environment = $3, target_os = $4, target_arch = $5, host_label = $6 WHERE id = $1`,
        [id, dto.psaInstanceId, dto.targetEnvironment, dto.targetOs, dto.targetArch, dto.hostLabel ?? null],
      );
      const changes: Record<string, unknown> = {};
      const cmp = (key: string, from: unknown, to: unknown) => {
        if ((from ?? null) !== (to ?? null)) changes[key] = { from: from ?? null, to: to ?? null };
      };
      cmp('psaInstanceId', before.psa_instance_id, dto.psaInstanceId);
      cmp('targetEnvironment', before.target_environment, dto.targetEnvironment);
      cmp('targetOs', before.target_os, dto.targetOs);
      cmp('targetArch', before.target_arch, dto.targetArch);
      cmp('hostLabel', before.host_label, dto.hostLabel);
      if (Object.keys(changes).length) {
        await this.audit.write(q, {
          orgId: auth.orgId, action: 'deployment.updated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
          targetType: 'deployment', targetId: id, targetDisplay: before.code as string, clientId: before.client_id as string, metadata: { code: before.code, changes },
        });
      }
      return this.detailIn(q, id);
    });
  }

  /**
   * Generates a package: validates client, PSA instance and services; creates the installation identity
   * and a single-use enrollment token; renders configuration, Compose files and documentation; zips them;
   * stores metadata (and the archive, encrypted, while it is usable); audits the event.
   */
  async generate(auth: AuthContext, id: string, dto: PackageGenerate, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      await this.expireStale(q, auth.orgId);
      const r = await this.require(q, id, true);
      const services = await this.servicesFor(q, r);
      const failing = this.readiness(r, services).filter((c) => !c.ok);
      if (failing.length) {
        throw new AppError(422, 'not-ready', `The deployment is not ready for a package: ${failing.map((c) => `${c.label} — ${c.detail}`).join(' ')}`);
      }

      const previous = await q.maybeOne<{ id: string; package_number: number }>(
        `SELECT id, package_number FROM deployment_packages WHERE deployment_id = $1 AND status = 'active' FOR UPDATE`,
        [id],
      );
      if (previous && !dto.replaceExisting) {
        throw new AppError(409, 'package-exists', `Package #${previous.package_number} is still valid. Confirm that it should be replaced; its enrollment token will stop working.`);
      }
      const { n } = await q.one<{ n: number }>('SELECT coalesce(max(package_number), 0) + 1 AS n FROM deployment_packages WHERE deployment_id = $1', [id]);
      if (previous) {
        await q.query(
          `UPDATE deployment_packages SET status = 'superseded', archive_ciphertext = NULL, archive_purged_at = clock_timestamp() WHERE id = $1`,
          [previous.id],
        );
        await q.query(
          `UPDATE enrollment_tokens SET revoked_at = clock_timestamp(), revoke_reason = $2 WHERE package_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
          [previous.id, `Superseded by package #${n}`],
        );
      }
      // Any token of an expired package is closed too, so only one token per deployment is ever open.
      await q.query(
        `UPDATE enrollment_tokens SET revoked_at = clock_timestamp(), revoke_reason = 'Expired; replaced by a new package'
         WHERE deployment_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [id],
      );

      const { now } = await q.one<{ now: Date }>('SELECT now() AS now');
      const expiresAt = new Date(now.getTime() + dto.tokenValidityHours * 3_600_000);
      const packageId = randomUUID();
      const installationId = randomUUID();
      const token = `${TOKEN_PREFIX}${randomToken(32)}`;
      const descriptor = this.adapters.get(r.provider_key as string).descriptor;
      const method = descriptor.authMethods.find((m) => m.key === r.psa_auth_method);
      const generatedBy = (await q.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [auth.userId])).display_name;
      const { imageRepository, imageVersion, imageDigest, agentGatewayUrl, heartbeatSeconds } = this.config.edge;
      const pkgServices = services.filter((s) => !s.requiresPsa || s.enabledOnPsa);
      const tls = await this.pki.ensure();

      const built = buildPackage({
        deployment: {
          id, code: r.code as string, targetEnvironment: r.target_environment as string, targetEnvironmentLabel: ENV_LABEL[r.target_environment as string] ?? (r.target_environment as string),
          targetOs: r.target_os as string, targetArch: r.target_arch as string, hostLabel: (r.host_label as string | null) ?? null,
        },
        client: { id: r.client_id as string, code: r.client_code as string, displayName: r.client_name as string },
        license: r.license_code ? { id: r.license_id as string, code: r.license_code as string, displayName: r.license_name as string, endsAt: ymd(r.license_ends) } : null,
        psa: {
          instanceId: r.psa_instance_id as string, code: r.psa_code as string, displayName: r.psa_name as string, providerKey: r.provider_key as PsaProviderKey,
          providerName: r.provider_name as string, authMethod: (r.psa_auth_method as string | null) ?? null, apiEndpoint: (r.psa_endpoint as string | null) ?? null,
          config: (r.psa_config as Record<string, string | number | boolean>) ?? {},
          credentialFields: method?.credentialFields.map((f) => ({ key: f.key, label: f.label, secret: f.secret })) ?? [],
        },
        services: pkgServices.map((s) => ({ key: s.key, name: s.name, usesPsa: s.requiresPsa, settings: s.settings })),
        packageNumber: n,
        installationId,
        generatedAt: now,
        generatedBy,
        image: { repository: imageRepository, version: imageVersion, digest: imageDigest },
        agentGatewayUrl,
        ca: { pem: tls.caPem, fingerprint: tls.caFingerprint },
        heartbeatSeconds,
        token,
        tokenExpiresAt: expiresAt,
      });

      await q.query(
        `INSERT INTO deployment_packages (id, organization_id, client_id, deployment_id, package_number, status, installation_id, image_repository,
           image_version, image_digest, target_environment, target_os, target_arch, config_snapshot, manifest, size_bytes, sha256,
           archive_ciphertext, generated_by, generated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [
          packageId, auth.orgId, r.client_id, id, n, installationId, imageRepository, imageVersion, imageDigest, r.target_environment, r.target_os, r.target_arch,
          JSON.stringify(built.config), JSON.stringify(built.files), built.sizeBytes, built.sha256,
          this.box.sealBytes(built.archive, `deployment-package:${packageId}`), auth.userId, now,
        ],
      );
      await q.query(
        `INSERT INTO enrollment_tokens (organization_id, client_id, deployment_id, package_id, token_hash, token_prefix, issued_by, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [auth.orgId, r.client_id, id, packageId, sha256(token), token.slice(0, TOKEN_PREFIX.length + 4), auth.userId, now, expiresAt],
      );
      await q.query(
        `UPDATE deployments SET lifecycle_state = 'package_generated', package_generated_at = $2, package_downloaded_at = NULL,
           image_version = $3, image_digest = $4 WHERE id = $1`,
        [id, now, imageVersion, imageDigest],
      );
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.package.generated', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: r.code as string, clientId: r.client_id as string,
        metadata: {
          code: r.code, packageNumber: n, installationId, sha256: built.sha256, sizeBytes: built.sizeBytes, files: built.files.length,
          image: `${imageRepository}:${imageVersion}${imageDigest ? `@${imageDigest}` : ''}`, enrollmentRef: token.slice(0, TOKEN_PREFIX.length + 4),
          enrollmentExpiresAt: expiresAt.toISOString(), validityHours: dto.tokenValidityHours, supersededPackage: previous?.package_number ?? null,
        },
      });
      return this.detailIn(q, id);
    });
  }

  async download(auth: AuthContext, id: string, packageId: string, meta: RequestMeta): Promise<{ archive: Buffer; fileName: string; sha256: string }> {
    return this.db.tenant(auth, async (q) => {
      await this.expireStale(q, auth.orgId);
      const d = await this.require(q, id, true);
      const pk = await q.maybeOne<Row>(
        'SELECT id, package_number, status, sha256, archive_ciphertext FROM deployment_packages WHERE id = $1 AND deployment_id = $2 FOR UPDATE',
        [packageId, id],
      );
      if (!pk) throw new AppError(404, 'not-found', 'Package not found.');
      if (pk.status !== 'active' || !pk.archive_ciphertext) {
        const why: Record<string, string> = {
          expired: 'its enrollment token has expired',
          superseded: 'a newer package replaced it',
          revoked: 'it was revoked',
          consumed: 'its token has already been used to enroll',
        };
        throw new AppError(410, 'package-unavailable', `Package #${pk.package_number} can no longer be downloaded: ${why[pk.status as string] ?? 'it is not active'}. Generate a new package.`);
      }
      const archive = this.box.openBytes(pk.archive_ciphertext as string, `deployment-package:${packageId}`);
      const digest = sha256(archive).toString('hex');
      if (digest !== pk.sha256) throw new AppError(500, 'package-integrity', 'The stored package failed its integrity check. Generate a new package.');

      await q.query(
        `INSERT INTO deployment_package_downloads (organization_id, client_id, deployment_id, package_id, downloaded_by, ip, user_agent, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [auth.orgId, d.client_id, id, packageId, auth.userId, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, digest],
      );
      const { download_count } = await q.one<{ download_count: number }>(
        `UPDATE deployment_packages SET download_count = download_count + 1, first_downloaded_at = coalesce(first_downloaded_at, clock_timestamp()),
           last_downloaded_at = clock_timestamp() WHERE id = $1 RETURNING download_count`,
        [packageId],
      );
      // Downloaded is not installed: only the agent's enrollment moves the deployment further.
      if (d.lifecycle_state === 'package_generated') {
        await q.query(`UPDATE deployments SET lifecycle_state = 'package_downloaded', package_downloaded_at = clock_timestamp() WHERE id = $1`, [id]);
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.package.downloaded', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { code: d.code, packageNumber: pk.package_number, sha256: digest, downloadNumber: download_count },
      });
      return { archive, fileName: `psacc-${(d.code as string).toLowerCase()}-package-${pk.package_number}.zip`, sha256: digest };
    });
  }

  async revoke(auth: AuthContext, id: string, packageId: string, reason: string, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      await this.expireStale(q, auth.orgId);
      const d = await this.require(q, id, true);
      const pk = await q.maybeOne<Row>('SELECT id, package_number, status FROM deployment_packages WHERE id = $1 AND deployment_id = $2 FOR UPDATE', [packageId, id]);
      if (!pk) throw new AppError(404, 'not-found', 'Package not found.');
      if (pk.status !== 'active') throw new AppError(409, 'package-not-active', `Package #${pk.package_number} is already ${pk.status}.`);
      await q.query(
        `UPDATE deployment_packages SET status = 'revoked', archive_ciphertext = NULL, archive_purged_at = clock_timestamp(),
           revoked_at = clock_timestamp(), revoked_by = $2, revoke_reason = $3 WHERE id = $1`,
        [packageId, auth.userId, reason],
      );
      await q.query(
        `UPDATE enrollment_tokens SET revoked_at = clock_timestamp(), revoke_reason = $2 WHERE package_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [packageId, reason],
      );
      if (isPreEnrollment(d.lifecycle_state)) {
        await q.query(`UPDATE deployments SET lifecycle_state = 'draft', package_downloaded_at = NULL WHERE id = $1`, [id]);
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.package.revoked', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { code: d.code, packageNumber: pk.package_number, reason },
      });
      return this.detailIn(q, id);
    });
  }

  /**
   * Revokes the deployment's machine certificate. The gateway refuses it on the next request; the
   * deployment returns to draft so that a new package (new installation identity and token) can
   * re-enroll the appliance.
   */
  async revokeAgentCertificate(auth: AuthContext, id: string, reason: string, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.require(q, id, true);
      const cert = await q.maybeOne<{ id: string; serial: string }>(`SELECT id, serial FROM agent_certificates WHERE deployment_id = $1 AND status = 'active' FOR UPDATE`, [id]);
      if (!cert) throw new AppError(409, 'no-active-certificate', 'This deployment has no active agent certificate.');
      await q.query(`UPDATE agent_certificates SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by = $2, revoke_reason = $3 WHERE id = $1`, [cert.id, auth.userId, reason]);
      await q.query(
        `UPDATE deployments SET lifecycle_state = 'draft', installation_id = NULL, health_state = 'unknown', health_reason = NULL,
           package_downloaded_at = NULL WHERE id = $1`,
        [id],
      );
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'agent.certificate.revoked', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { code: d.code, serial: cert.serial, reason, lifecycleFrom: d.lifecycle_state, lifecycleTo: 'draft' },
      });
      return this.detailIn(q, id);
    });
  }

  /** The license must belong to the client and be usable. */
  private async assertLicense(q: Queryable, clientId: string, licenseId: string): Promise<string> {
    const l = await q.maybeOne<{ status: string; ends_at: Date | null }>('SELECT status, ends_at FROM licenses WHERE id = $1 AND client_id = $2', [licenseId, clientId]);
    if (!l) throw new ValidationFailedException([{ path: 'licenseId', message: 'Choose a license of this client.' }]);
    if (l.status !== 'active') throw new ValidationFailedException([{ path: 'licenseId', message: `The license is ${l.status}.` }]);
    return licenseId;
  }

  /**
   * Suspends a deployment (Module 14): reversible. The lifecycle state becomes `suspended` (the previous
   * state is kept), packages and commands stop, enrollment is refused, and an enrolled appliance receives a
   * signed `suspend` command that pauses its PSA work while keeping its data and local UI.
   */
  async suspend(auth: AuthContext, id: string, reason: string, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.require(q, id, true);
      if (d.is_synthetic) throw new AppError(409, 'synthetic', 'Synthetic sample records cannot be suspended.');
      const from = d.lifecycle_state as string;
      if (from === 'suspended') throw new AppError(409, 'already-suspended', 'The deployment is already suspended.');
      if (from === 'decommissioned') throw new AppError(409, 'decommissioned', 'A decommissioned deployment cannot be suspended.');
      await q.query(
        `UPDATE deployments SET lifecycle_state = 'suspended', suspended_at = clock_timestamp(), suspended_reason = $2, suspended_from_state = $3, resumed_at = NULL WHERE id = $1`,
        [id, reason, from],
      );
      let commandId: string | null = null;
      if (['enrolled', 'verified'].includes(from) && d.installation_id) {
        commandId = (await this.commands.issueIn(q, auth, id, { type: 'suspend', params: { reason }, expiresInMinutes: 1440, note: 'Lifecycle: suspended' }, meta, { lifecycle: true })).id;
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.suspended', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { code: d.code, reason, lifecycleFrom: from, lifecycleTo: 'suspended', commandId },
      });
      return this.detailIn(q, id);
    });
  }

  /** Resumes a suspended deployment: the previous lifecycle state returns and an enrolled appliance receives a signed `resume` command. */
  async resume(auth: AuthContext, id: string, reason: string, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.require(q, id, true);
      if (d.lifecycle_state !== 'suspended') throw new AppError(409, 'not-suspended', 'The deployment is not suspended.');
      const to = (d.suspended_from_state as string) ?? 'draft';
      if (licenseEffectiveStatus(d) !== 'active') throw new AppError(409, 'license-inactive', `The deployment's license is ${licenseEffectiveStatus(d) ?? 'missing'}; resume needs an active license.`);
      await q.query(
        `UPDATE deployments SET lifecycle_state = $2, suspended_at = NULL, suspended_reason = NULL, suspended_from_state = NULL, resumed_at = clock_timestamp() WHERE id = $1`,
        [id, to],
      );
      let commandId: string | null = null;
      if (['enrolled', 'verified'].includes(to) && d.installation_id) {
        commandId = (await this.commands.issueIn(q, auth, id, { type: 'resume', params: {}, expiresInMinutes: 1440, note: 'Lifecycle: resumed' }, meta, { lifecycle: true })).id;
      }
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.resumed', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { code: d.code, reason, lifecycleFrom: 'suspended', lifecycleTo: to, commandId },
      });
      return this.detailIn(q, id);
    });
  }

  /**
   * Decommissions a deployment (Module 15): final. The management identity is retired on the Control Plane —
   * the active certificate, open enrollment tokens and the usable package (archive purged) are revoked and
   * open commands are cancelled — and the record keeps why, by whom and what was retired. Nothing on the
   * client's host is touched: the appliance learns at its next heartbeat that its identity was retired
   * (`decommissioned`), stops its PSA work and shows the removal instructions; tickets, data and the local
   * admin stay there until the host operator runs the uninstall script.
   */
  async decommission(auth: AuthContext, id: string, dto: DeploymentDecommission, meta: RequestMeta): Promise<DeploymentDetail> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.require(q, id, true);
      if (d.is_synthetic) throw new AppError(409, 'synthetic', 'Synthetic sample records cannot be decommissioned.');
      if (d.lifecycle_state === 'decommissioned') throw new AppError(409, 'already-decommissioned', 'The deployment is already decommissioned.');
      if (dto.confirmCode.toUpperCase() !== (d.code as string).toUpperCase()) {
        throw new ValidationFailedException([{ path: 'confirmCode', message: `Type ${d.code} exactly to confirm.` }]);
      }
      const from = (d.lifecycle_state === 'suspended' ? d.suspended_from_state : d.lifecycle_state) as string;
      const why = `Decommissioned: ${dto.reason}`.slice(0, 200);
      const certs = await q.query<{ serial: string }>(
        `UPDATE agent_certificates SET status = 'revoked', revoked_at = clock_timestamp(), revoked_by = $2, revoke_reason = $3 WHERE deployment_id = $1 AND status = 'active' RETURNING serial`,
        [id, auth.userId, why],
      );
      const tokens = await q.query<{ id: string }>(
        `UPDATE enrollment_tokens SET revoked_at = clock_timestamp(), revoke_reason = $2 WHERE deployment_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id`,
        [id, why],
      );
      const packages = await q.query<{ id: string }>(
        `UPDATE deployment_packages SET status = 'revoked', archive_ciphertext = NULL, archive_purged_at = clock_timestamp(), revoked_at = clock_timestamp(), revoked_by = $2, revoke_reason = $3
         WHERE deployment_id = $1 AND status = 'active' RETURNING id`,
        [id, auth.userId, why],
      );
      const commands = await q.query<{ id: string }>(
        `UPDATE remote_commands SET status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = $2 WHERE deployment_id = $1 AND status = ANY($3::text[]) RETURNING id`,
        [id, auth.userId, [...COMMAND_OPEN_STATUSES]],
      );
      const identity: DecommissionIdentitySummary = { certificatesRevoked: certs.length, tokensRevoked: tokens.length, packagesRevoked: packages.length, commandsCancelled: commands.length };
      await q.query(
        `UPDATE deployments SET lifecycle_state = 'decommissioned', decommissioned_at = clock_timestamp(), decommissioned_by = $2, decommissioned_reason = $3,
           decommissioned_from_state = $4, decommission_identity = $5, suspended_at = NULL, suspended_reason = NULL, suspended_from_state = NULL,
           health_state = 'unknown', health_reason = 'Decommissioned', health_evaluated_at = clock_timestamp(),
           health_findings = '[{"code":"deployment_decommissioned","severity":"info","message":"The deployment is decommissioned: its appliance identity was retired and it no longer reports."}]'::jsonb
         WHERE id = $1`,
        [id, auth.userId, dto.reason, from, JSON.stringify(identity)],
      );
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.decommissioned', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { code: d.code, reason: dto.reason, lifecycleFrom: from, lifecycleTo: 'decommissioned', identity, certificateSerials: certs.map((c) => c.serial), installationId: d.installation_id ?? null },
      });
      return this.detailIn(q, id);
    });
  }

  /**
   * Removes a decommissioned deployment record and everything the Control Plane still holds about it
   * (identity history, packages, reports, commands). Audited first; the audit trail itself is never deleted.
   */
  async remove(auth: AuthContext, id: string, confirmCode: string, meta: RequestMeta): Promise<DeploymentRemovalResult> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.require(q, id, true);
      if (d.lifecycle_state !== 'decommissioned') throw new AppError(409, 'not-decommissioned', 'Only a decommissioned deployment can be removed. Decommission it first.');
      if (confirmCode.toUpperCase() !== (d.code as string).toUpperCase()) {
        throw new ValidationFailedException([{ path: 'confirmCode', message: `Type ${d.code} exactly to confirm.` }]);
      }
      const serials = (await q.query<{ serial: string; status: string }>('SELECT serial, status FROM agent_certificates WHERE deployment_id = $1 ORDER BY issued_at', [id]))
        .map((c) => `${c.serial}:${c.status}`);
      const deleted = (await q.one<{ d: Record<string, number> }>('SELECT app_remove_deployment($1) AS d', [id])).d;
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.removed', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: id, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: {
          code: d.code, decommissionedAt: iso(d.decommissioned_at), decommissionedReason: d.decommissioned_reason ?? null, metadataPurgedAt: iso(d.metadata_purged_at),
          installationId: d.installation_id ?? null, certificates: serials, deleted,
        },
      });
      return { id, code: d.code as string, removedAt: new Date().toISOString(), deleted };
    });
  }

  async edgeImage(auth: AuthContext): Promise<EdgeImageInfo> {
    const { imageRepository, imageVersion, imageDigest } = this.config.edge;
    const usage = await this.db.tenant(auth, (q) =>
      q.query<{ version: string | null; deployments: number; synthetic: number }>(
        `SELECT image_version AS version, count(*)::int AS deployments, count(*) FILTER (WHERE is_synthetic)::int AS synthetic
         FROM deployments WHERE lifecycle_state <> 'decommissioned' GROUP BY 1 ORDER BY 1 DESC NULLS LAST`,
      ),
    );
    return {
      repository: imageRepository,
      version: imageVersion,
      digest: imageDigest,
      entrypoints: [
        { name: 'edge-migrate', purpose: 'One-shot: creates the roles and tables, applies migrations, verifies the schema (idempotent)' },
        { name: 'edge-api', purpose: 'Application API and the local administration / setup UI (127.0.0.1 only)' },
        { name: 'edge-worker', purpose: 'PSA integration adapter and ticket / synchronization engine' },
        { name: 'edge-agent', purpose: 'Monitoring and management agent: allow-listed reports over an outbound connection' },
      ],
      usage,
    };
  }

  async activity(auth: AuthContext, id: string, page: number, pageSize: number): Promise<Paged<AuditEventDto>> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.require(q, id);
      const filter = `client_id = $1 AND target_type = 'deployment' AND target_id = $2`;
      const params = [d.client_id, id];
      const total = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE ${filter}`, params);
      const rows = await q.query<Row>(
        `SELECT id, occurred_at, actor_type, actor_user_id, actor_display, action, target_type, target_id, target_display, outcome,
                host(ip) AS ip, request_id, metadata
         FROM audit_events WHERE ${filter} ORDER BY occurred_at DESC LIMIT $3 OFFSET $4`,
        [...params, pageSize, (page - 1) * pageSize],
      );
      return {
        items: rows.map((r) => ({
          id: r.id as string, occurredAt: iso(r.occurred_at)!, actorType: r.actor_type as AuditEventDto['actorType'],
          actorUserId: (r.actor_user_id as string | null) ?? null, actorDisplay: r.actor_display as string, action: r.action as string,
          targetType: (r.target_type as string | null) ?? null, targetId: (r.target_id as string | null) ?? null,
          targetDisplay: (r.target_display as string | null) ?? null, outcome: r.outcome as AuditOutcome, ip: (r.ip as string | null) ?? null,
          requestId: (r.request_id as string | null) ?? null, metadata: (r.metadata as Record<string, unknown>) ?? {},
        })),
        page, pageSize, total: total.n,
      };
    });
  }
}
