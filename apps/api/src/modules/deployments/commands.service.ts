import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  COMMAND_OPEN_STATUSES,
  COMMAND_TYPE_INFO,
  type CommandIssue,
  type CommandResult,
  type CommandStatus,
  type CommandType,
  canonicalCommand,
  commandParamsSchemas,
  type RemoteCommandDto,
  type RemoteOperationsDto,
  type SignedCommand,
} from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { SecretBox } from '../../common/crypto.js';
import { JsonLogger } from '../../common/logger.js';
import { AppError } from '../../common/problem.filter.js';
import { ValidationFailedException } from '../../common/zod.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Remote commands (Module 13): signed, time-limited, pulled by the agent, audited on both sides.
 *
 * Signing: one Ed25519 key per Control Plane (`command_signing_keys`, private key encrypted with the
 * data key like the PKI keys). The public key reaches the agent in the enrollment response (over the
 * pinned gateway TLS) and is pinned there; a command with a bad signature, a foreign target, an unknown
 * type or a past expiry is refused by the agent and never executed.
 */

type Row = Record<string, unknown>;
const SWEEP_INTERVAL_MS = 60_000;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);

export interface SigningKey { keyId: string; publicKeyPem: string }

@Injectable()
export class CommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly box: SecretBox;
  private sweepTimer?: NodeJS.Timeout;
  private key?: { keyId: string; publicKeyPem: string; privateKeyPem: string };

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.box = new SecretBox(config.secrets.dataEncryptionKey);
  }

  onModuleInit() {
    this.sweepTimer = setInterval(() => {
      this.sweepExpired()
        .then((n) => n && this.logger.log({ msg: 'Expired remote commands closed', count: n }, 'CommandsService'))
        .catch((err) => this.logger.warn({ msg: 'Remote command expiry sweep failed', err }, 'CommandsService'));
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Cross-organization sweep, run periodically by the API process (and by the tests). */
  async sweepExpired(): Promise<number> {
    const r = await this.db.unscoped((q) => q.one<{ n: number }>('SELECT app_expire_remote_commands() AS n'));
    return r.n;
  }

  // ---- signing key ----------------------------------------------------------------------------

  /** The Control Plane's command-signing key; created on first use. */
  async signingKey(): Promise<SigningKey> {
    const k = await this.ensureKey();
    return { keyId: k.keyId, publicKeyPem: k.publicKeyPem };
  }

  private async ensureKey() {
    if (this.key) return this.key;
    let row = await this.db.unscoped((q) => q.maybeOne<Row>('SELECT key_id, public_key_pem, private_key_ciphertext FROM command_signing_keys WHERE id = 1'));
    if (!row) {
      const pair = generateKeyPairSync('ed25519');
      const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const keyId = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
      await this.db.unscoped((q) =>
        q.query('INSERT INTO command_signing_keys (id, key_id, public_key_pem, private_key_ciphertext) VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING', [
          keyId, publicKeyPem, this.box.seal(privateKeyPem, 'commands:signing'),
        ]),
      );
      row = await this.db.unscoped((q) => q.one<Row>('SELECT key_id, public_key_pem, private_key_ciphertext FROM command_signing_keys WHERE id = 1'));
      this.logger.log({ msg: 'Command signing key created', keyId: row.key_id }, 'CommandsService');
    }
    this.key = { keyId: row.key_id as string, publicKeyPem: row.public_key_pem as string, privateKeyPem: this.box.open(row.private_key_ciphertext as string, 'commands:signing') };
    return this.key;
  }

  private sign(canonical: string, privateKeyPem: string): Buffer {
    return edSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem));
  }

  /** Verifies a signed command against a public key (used by the tests and available to tooling). */
  static verify(c: SignedCommand, publicKeyPem: string): boolean {
    const { signature, ...rest } = c;
    return edVerify(null, Buffer.from(canonicalCommand(rest), 'utf8'), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64'));
  }

  // ---- dashboard side -------------------------------------------------------------------------

  private async deployment(q: Queryable, id: string, lock = false): Promise<Row> {
    const d = await q.maybeOne<Row>(
      `SELECT d.id, d.code, d.client_id, d.lifecycle_state, d.installation_id, d.agent_version, d.is_synthetic,
              (SELECT l.payload->>'agent' FROM deployment_report_latest l WHERE l.deployment_id = d.id AND l.report_type = 'versions') AS running_image
       FROM deployments d WHERE d.id = $1 ${lock ? 'FOR UPDATE OF d' : ''}`,
      [id],
    );
    if (!d) throw new AppError(404, 'not-found', 'Deployment not found.');
    return d;
  }

  private issuable(d: Row, lifecycle = false): { ok: boolean; reason: string | null } {
    if (d.is_synthetic) return { ok: false, reason: 'This is a synthetic sample record; no appliance exists for it.' };
    if (d.lifecycle_state === 'decommissioned') return { ok: false, reason: 'The deployment is decommissioned: its appliance identity was retired, so no command can reach it.' };
    if (d.lifecycle_state === 'suspended' && !lifecycle) {
      return { ok: false, reason: 'The deployment is suspended. Resume it from the Overview page; only the lifecycle may command a suspended appliance.' };
    }
    if (lifecycle && d.installation_id && ['enrolled', 'verified', 'suspended'].includes(d.lifecycle_state as string)) return { ok: true, reason: null };
    if (!['enrolled', 'verified'].includes(d.lifecycle_state as string) || !d.installation_id) {
      return { ok: false, reason: 'Commands can be issued once the appliance has enrolled; the agent pulls them with its heartbeat.' };
    }
    return { ok: true, reason: null };
  }

  private upgradeTarget() {
    return { repository: this.config.edge.imageRepository, version: this.config.edge.imageVersion, digest: this.config.edge.imageDigest };
  }

  private toDto(r: Row): RemoteCommandDto {
    return {
      id: r.id as string,
      type: r.command_type as CommandType,
      params: (r.params ?? {}) as RemoteCommandDto['params'],
      status: r.status as CommandStatus,
      issuedBy: (r.issued_by_email as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      issuedAt: iso(r.issued_at)!,
      expiresAt: iso(r.expires_at)!,
      deliveredAt: iso(r.delivered_at),
      finishedAt: iso(r.finished_at),
      cancelledAt: iso(r.cancelled_at),
      cancelledBy: (r.cancelled_by_email as string | null) ?? null,
      result: r.result_code ? { code: r.result_code as string, message: (r.result_message as string) ?? '', startedAt: iso(r.result_started_at) ?? iso(r.delivered_at) ?? iso(r.issued_at)!, agentVersion: (r.result_agent_version as string) ?? '' } : null,
      keyId: r.key_id as string,
    };
  }

  private async commandsIn(q: Queryable, deploymentId: string, status: CommandStatus | undefined, limit: number): Promise<RemoteCommandDto[]> {
    const rows = await q.query<Row>(
      `SELECT c.*, u.email AS issued_by_email, cu.email AS cancelled_by_email
       FROM remote_commands c LEFT JOIN users u ON u.id = c.issued_by LEFT JOIN users cu ON cu.id = c.cancelled_by
       WHERE c.deployment_id = $1 AND ($2::text IS NULL OR c.status = $2)
       ORDER BY c.issued_at DESC LIMIT $3`,
      [deploymentId, status ?? null, limit],
    );
    return rows.map((r) => this.toDto(r));
  }

  async operations(auth: AuthContext, deploymentId: string, status: CommandStatus | undefined, limit: number): Promise<RemoteOperationsDto> {
    const key = await this.signingKey();
    return this.db.tenant(auth, async (q) => {
      const d = await this.deployment(q, deploymentId);
      const commands = await this.commandsIn(q, deploymentId, status, limit);
      const open = await q.query<{ command_type: CommandType; id: string }>(
        `SELECT command_type, id FROM remote_commands WHERE deployment_id = $1 AND status = ANY($2::text[])`,
        [deploymentId, [...COMMAND_OPEN_STATUSES]],
      );
      const target = this.upgradeTarget();
      const running = (d.running_image as string | null) ?? null;
      const { ok, reason } = this.issuable(d);
      return {
        deploymentId,
        canIssue: ok,
        reason,
        upgradeTarget: target,
        runningVersion: running,
        upToDate: running !== null && running === target.version,
        open: Object.fromEntries(open.map((r) => [r.command_type, r.id])),
        signingKeyId: key.keyId,
        commands,
      };
    });
  }

  async issue(auth: AuthContext, deploymentId: string, dto: CommandIssue, meta: RequestMeta): Promise<RemoteCommandDto> {
    if (COMMAND_TYPE_INFO[dto.type].lifecycleOnly) throw new AppError(409, 'lifecycle-only', 'Suspend and resume are lifecycle actions: use the deployment Overview page.');
    return this.db.tenant(auth, (q) => this.issueIn(q, auth, deploymentId, dto, meta));
  }

  /** Issues inside an existing tenant transaction (the lifecycle uses it for suspend / resume). */
  async issueIn(q: Queryable, auth: AuthContext, deploymentId: string, dto: CommandIssue, meta: RequestMeta, opts: { lifecycle?: boolean } = {}): Promise<RemoteCommandDto> {
    const key = await this.ensureKey();
    // Parameters are validated per type. The upgrade target is the Control Plane's standard image, never caller input.
    let params: Record<string, string | number | boolean | null>;
    if (dto.type === 'upgrade') {
      params = this.upgradeTarget();
    } else {
      const parsed = commandParamsSchemas[dto.type].safeParse(dto.params ?? {});
      if (!parsed.success) throw new ValidationFailedException(parsed.error.issues.map((i) => ({ path: ['params', ...i.path].join('.'), message: i.message })));
      params = parsed.data as Record<string, string | number | boolean | null>;
    }
    {
      const d = await this.deployment(q, deploymentId, true);
      const { ok, reason } = this.issuable(d, opts.lifecycle);
      if (!ok) throw new AppError(409, 'not-issuable', reason!);
      if (dto.type === 'upgrade' && d.running_image && d.running_image === params.version) {
        throw new AppError(409, 'already-up-to-date', `The appliance already runs image version ${String(params.version)}.`);
      }
      // Staging and production pin the image by digest; development and test stacks run locally built images.
      if (dto.type === 'upgrade' && this.config.edge.imageDigest === null && !['development', 'test'].includes(this.config.env)) {
        throw new AppError(409, 'image-not-pinned', 'Upgrades require the standard image to be pinned by digest (EDGE_IMAGE_DIGEST).');
      }
      const dup = await q.maybeOne<{ id: string }>(
        `SELECT id FROM remote_commands WHERE deployment_id = $1 AND command_type = $2 AND status = ANY($3::text[])`,
        [deploymentId, dto.type, [...COMMAND_OPEN_STATUSES]],
      );
      if (dup) throw new AppError(409, 'command-open', 'A command of this type is already waiting for the appliance. Cancel it or wait for its result.');
      const id = (await q.one<{ id: string }>('SELECT gen_random_uuid() AS id')).id;
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + dto.expiresInMinutes * 60_000);
      const unsigned: Omit<SignedCommand, 'signature'> = {
        id, type: dto.type, deploymentId, installationId: d.installation_id as string, params, issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), keyId: key.keyId,
      };
      const signature = this.sign(canonicalCommand(unsigned), key.privateKeyPem);
      await q.query(
        `INSERT INTO remote_commands (id, organization_id, client_id, deployment_id, installation_id, command_type, params, issued_by, issued_at, expires_at, note, key_id, signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, auth.orgId, d.client_id, deploymentId, d.installation_id, dto.type, JSON.stringify(params), auth.userId, issuedAt, expiresAt, dto.note ?? null, key.keyId, signature],
      );
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.command.issued', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: deploymentId, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { commandId: id, type: dto.type, params, expiresAt: expiresAt.toISOString(), keyId: key.keyId, note: dto.note ?? null },
      });
      return (await this.commandsIn(q, deploymentId, undefined, 200)).find((c) => c.id === id)!;
    }
  }

  async cancel(auth: AuthContext, deploymentId: string, commandId: string, meta: RequestMeta): Promise<RemoteCommandDto> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.deployment(q, deploymentId);
      const c = await q.maybeOne<Row>('SELECT * FROM remote_commands WHERE id = $1 AND deployment_id = $2 FOR UPDATE', [commandId, deploymentId]);
      if (!c) throw new AppError(404, 'not-found', 'Command not found.');
      if (c.status !== 'pending') throw new AppError(409, 'not-cancellable', 'Only a command the agent has not fetched yet can be cancelled.');
      await q.query(`UPDATE remote_commands SET status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = $2 WHERE id = $1`, [commandId, auth.userId]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'deployment.command.cancelled', outcome: 'success', actorUserId: auth.userId, actorDisplay: await this.actor(q, auth), meta,
        targetType: 'deployment', targetId: deploymentId, targetDisplay: d.code as string, clientId: d.client_id as string,
        metadata: { commandId, type: c.command_type },
      });
      return (await this.commandsIn(q, deploymentId, undefined, 200)).find((x) => x.id === commandId)!;
    });
  }

  private async actor(q: Queryable, auth: AuthContext) {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  // ---- agent side (called by the gateway with the certificate fingerprint) --------------------

  /** Open commands for the agent's deployment, marked delivered. Unknown identities get an empty list. */
  async fetchForAgent(fingerprint: Buffer): Promise<SignedCommand[]> {
    const rows = await this.db.unscoped((q) => q.query<Row>('SELECT * FROM agent_commands_fetch($1)', [fingerprint]));
    return rows
      .filter((r) => r.result === 'ok' && r.id)
      .map((r) => ({
        id: r.id as string,
        type: r.command_type as CommandType,
        deploymentId: r.deployment_id as string,
        installationId: r.installation_id as string,
        params: (r.params ?? {}) as SignedCommand['params'],
        issuedAt: (r.issued_at as Date).toISOString(),
        expiresAt: (r.expires_at as Date).toISOString(),
        keyId: r.key_id as string,
        signature: (r.signature as Buffer).toString('base64'),
      }));
  }

  async recordResult(fingerprint: Buffer, r: CommandResult, ip: string | null): Promise<{ result: string; commandType: string | null }> {
    const row = await this.db.unscoped((q) =>
      q.one<{ result: string; command_type: string | null }>('SELECT * FROM agent_command_result($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
        fingerprint, r.commandId, r.status, r.code, r.message, r.startedAt, r.finishedAt, r.agentVersion, ip,
      ]),
    );
    return { result: row.result, commandType: row.command_type };
  }
}
