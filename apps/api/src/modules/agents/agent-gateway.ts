import { commandResultSchema } from '@psacc/contracts';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { z } from 'zod';
import { JsonLogger } from '../../common/logger.js';
import { AppError } from '../../common/problem.filter.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { HealthService } from '../health/health.service.js';
import { CommandsService } from '../deployments/commands.service.js';
import { LicenseTokensService } from '../deployments/license-tokens.service.js';
import { ClientDeletionService } from './client-deletion.service.js';
import { CsrRejected, PkiService } from './pki.service.js';

/** Single-use enrollment: token + identity + CSR. No client certificate yet. */
const enrollSchema = z.strictObject({
  token: z.string().regex(/^psacc_enr_[A-Za-z0-9_-]{20,}$/),
  deploymentId: z.uuid(),
  installationId: z.uuid(),
  csr: z.string().min(100).max(8192),
  agentVersion: z.string().max(40).regex(/^[0-9A-Za-z.+-]+$/),
});
const heartbeatSchema = z.strictObject({
  agentVersion: z.string().max(40).regex(/^[0-9A-Za-z.+-]+$/),
  observedAt: z.iso.datetime({ offset: true }),
  bufferedReports: z.number().int().min(0).max(100_000).optional(),
});
const renewSchema = z.strictObject({ csr: z.string().min(100).max(8192) });
// Module 13: a result for a signed command the agent executed (schema in @psacc/contracts).


/** Per certificate identity. An agent sends ≈ 8 requests a minute at the fastest heartbeat (15 s). */
const AGENT_REQUESTS_PER_MINUTE = 120;

const MESSAGES: Record<string, [number, string]> = {
  'invalid-token': [401, 'The enrollment token is not valid.'],
  'token-expired': [401, 'The enrollment token has expired. Generate a new package in the dashboard.'],
  'token-revoked': [401, 'The enrollment token was revoked or replaced by a newer package.'],
  'token-used': [409, 'The enrollment token has already been used. Each token works once.'],
  'identity-mismatch': [403, 'The deployment or installation does not match this enrollment token.'],
  'already-enrolled': [409, 'This deployment is already enrolled.'],
  'duplicate-installation': [409, 'This installation ID is already registered.'],
  'not-enrollable': [409, 'The deployment can no longer be enrolled with this token.'],
  // Module 14: lifecycle and licensing
  'deployment-suspended': [403, 'The deployment is suspended. Resume it in the dashboard before enrolling.'],
  'license-missing': [403, 'The deployment has no license. Assign one in the dashboard and generate a new package.'],
  'license-inactive': [403, 'The deployment\'s license is not active (suspended, expired or revoked).'],
  'certificate-required': [401, 'A client certificate issued by this platform is required.'],
  'deployment-decommissioned': [403, 'The deployment was decommissioned. Its identity is retired; this package cannot enroll.'],
  unknown: [401, 'The client certificate is not registered.'],
  decommissioned: [410, 'This deployment was decommissioned by the provider. Its management identity is retired; follow the removal instructions on the host.'],
  revoked: [403, 'The client certificate has been revoked. Re-enroll with a new package.'],
  superseded: [403, 'The client certificate was replaced by a renewed one.'],
  expired: [403, 'The client certificate has expired. Re-enroll with a new package.'],
  // Module 13: command results
  unknown_command: [404, 'No such command for this appliance.'],
  not_open: [409, 'The command is no longer open (it finished, expired or was cancelled).'],
  invalid_status: [400, 'The result status is not valid.'],
};

/**
 * The agent gateway: a separate HTTPS listener that edge agents dial out to (AD-1).
 *   POST /agent/v1/enroll     token + CSR → machine certificate (no client certificate)
 *   POST /agent/v1/heartbeat  mTLS
 *   POST /agent/v1/renew      mTLS + CSR → renewed certificate
 *   POST /agent/v1/reports    mTLS; a batch of allow-listed reports (strict schemas), evaluated on receipt
 *   POST /agent/v1/delete     mTLS; the client deletes the deployment from the appliance (Module 17)
 *   GET  /agent/v1/health     liveness of the gateway itself
 * Every certificate is also checked against the database on each request (revocation is immediate).
 */
@Injectable()
export class AgentGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private server: Server | null = null;
  private retry: NodeJS.Timeout | null = null;
  private readonly hits = new Map<string, { n: number; reset: number }>();

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(PkiService) private readonly pki: PkiService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(CommandsService) private readonly commands: CommandsService,
    @Inject(LicenseTokensService) private readonly licenseTokens: LicenseTokensService,
    @Inject(ClientDeletionService) private readonly deletion: ClientDeletionService,
  ) {}

  /** Starts in the background and retries, so the API never fails to boot because the gateway cannot start yet (e.g. migrations pending). */
  onApplicationBootstrap() {
    if (!this.config.gateway.enabled) return;
    const attempt = () => {
      this.retry = null;
      this.start().catch((err) => {
        this.logger.warn({ msg: 'Agent gateway not started; retrying in 5 s', err: (err as Error).message }, 'AgentGateway');
        this.retry = setTimeout(attempt, 5_000);
      });
    };
    attempt();
  }

  async onApplicationShutdown() {
    if (this.retry) clearTimeout(this.retry);
    await this.stop();
  }

  get address(): AddressInfo | null {
    return (this.server?.address() as AddressInfo | null) ?? null;
  }

  async start(port = this.config.gateway.port, host = this.config.gateway.host) {
    if (this.server) return;
    const tls = await this.pki.ensure();
    const server = createServer(
      { key: tls.serverKeyPem, cert: tls.serverCertPem, ca: [tls.caPem], requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2' },
      (req, res) => void this.handle(req, res),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    this.logger.log({ msg: 'Agent gateway listening', host, port: this.address?.port, names: tls.names }, 'AgentGateway');
  }

  async stop() {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private fail(res: ServerResponse, code: string) {
    const [status, message] = MESSAGES[code] ?? [400, 'Request refused.'];
    this.send(res, status, { error: code, message });
  }

  /** Sliding one-minute window per key (an address, or a certificate identity). */
  private limited(key: string, limit: number): boolean {
    const now = Date.now();
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + 60_000 });
      return false;
    }
    h.n += 1;
    return h.n > limit;
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 256 * 1024) throw new Error('too-large');
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  /** SHA-256 of the presented client certificate, if TLS verified it against the platform CA. */
  private clientFingerprint(req: IncomingMessage): Buffer | null {
    const sock = req.socket as TLSSocket;
    if (!sock.authorized) return null;
    const peer = sock.getPeerCertificate();
    return peer?.raw ? createHash('sha256').update(peer.raw).digest() : null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '') || null;
    const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
    try {
      if (route === 'GET /agent/v1/health') return this.send(res, 200, { status: 'ok' });
      if (req.method !== 'POST') return this.send(res, 404, { error: 'not-found' });
      // Enrollment and anything without a certificate are limited per source address. Authenticated
      // routes are limited per certificate identity: many appliances share one address behind NAT,
      // and an agent needs only a few requests per minute (heartbeat, reports, the odd renewal).
      const authFp = route.endsWith('/enroll') ? null : this.clientFingerprint(req);
      const limitKey = authFp ? `id:${authFp.toString('hex')}` : `ip:${ip ?? 'unknown'}`;
      const limit = route.endsWith('/enroll') ? this.config.gateway.enrollPerMinute : authFp ? AGENT_REQUESTS_PER_MINUTE : 60;
      if (this.limited(limitKey, limit)) return this.send(res, 429, { error: 'rate-limited', message: 'Too many requests.' });
      let input: unknown;
      try {
        input = await this.body(req);
      } catch {
        return this.send(res, 400, { error: 'invalid-body', message: 'The request body must be JSON (at most 256 KB).' });
      }
      if (route === 'POST /agent/v1/enroll') return await this.enroll(input, ip, res);
      if (route === 'POST /agent/v1/delete') {
        // Module 17: the client's local administrator deletes the deployment from the appliance (mTLS identity).
        const fp = this.clientFingerprint(req);
        if (!fp) return this.fail(res, 'certificate-required');
        const out = await this.deletion.deleteFromAppliance(fp, input, ip);
        return out.ok ? this.send(res, 200, out.result) : this.send(res, out.status, { error: out.code, message: out.message });
      }
      if (route === 'POST /agent/v1/heartbeat' || route === 'POST /agent/v1/renew' || route === 'POST /agent/v1/reports' || route === 'POST /agent/v1/command-results') {
        const fp = this.clientFingerprint(req);
        if (!fp) return this.fail(res, 'certificate-required');
        if (route.endsWith('reports')) return await this.reports(fp, input, ip, res);
        if (route.endsWith('command-results')) return await this.commandResult(fp, input, ip, res);
        return route.endsWith('heartbeat') ? await this.heartbeat(fp, input, res) : await this.renew(fp, input, ip, res);
      }
      return this.send(res, 404, { error: 'not-found' });
    } catch (err) {
      this.logger.error({ msg: 'Agent gateway request failed', route, err }, undefined, 'AgentGateway');
      if (!res.headersSent) this.send(res, 500, { error: 'internal', message: 'The request could not be processed.' });
    }
  }

  private async enroll(input: unknown, ip: string | null, res: ServerResponse) {
    const p = enrollSchema.safeParse(input);
    if (!p.success) return this.send(res, 400, { error: 'invalid-request', message: 'The enrollment request is incomplete or malformed.' });
    const tokenHash = createHash('sha256').update(p.data.token).digest();
    const check = await this.db.unscoped((q) =>
      q.one<{ result: string; deployment_code: string | null }>('SELECT * FROM agent_enrollment_check($1, $2, $3, $4)', [tokenHash, p.data.deploymentId, p.data.installationId, ip]),
    );
    if (check.result !== 'ok') return this.fail(res, check.result);
    let cert;
    try {
      cert = await this.pki.issueAgentCertificate(p.data.csr, { deploymentId: p.data.deploymentId, deploymentCode: check.deployment_code!, installationId: p.data.installationId });
    } catch (err) {
      if (err instanceof CsrRejected) return this.send(res, 400, { error: err.code, message: err.message });
      throw err;
    }
    // The certificate is only returned if this request wins the single use of the token.
    const done = await this.db.unscoped((q) =>
      q.one<{ result: string; organization_id: string | null }>('SELECT * FROM agent_enrollment_complete($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
        tokenHash, p.data.deploymentId, p.data.installationId, cert.serial, cert.fingerprint, cert.subject, cert.notBefore, cert.notAfter, p.data.agentVersion, ip,
      ]),
    );
    if (done.result !== 'ok') return this.fail(res, done.result);
    // Evaluate at once so the deployment reads "awaiting the first agent reports" rather than "not evaluated".
    await this.health.afterHeartbeat(done.organization_id!, p.data.deploymentId);
    const tls = await this.pki.ensure();
    this.logger.log({ msg: 'Agent enrolled', deployment: check.deployment_code, serial: cert.serial }, 'AgentGateway');
    const signing = await this.commands.signingKey();
    // Module 16: the first renewed license token travels with the certificate.
    const license = await this.db.tenant({ orgId: done.organization_id!, scopeAll: true }, (q) => this.licenseTokens.renewalFor(q, p.data.deploymentId, p.data.installationId));
    return this.send(res, 201, {
      certificate: cert.pem,
      license,
      caCertificate: tls.caPem,
      serial: cert.serial,
      notAfter: cert.notAfter.toISOString(),
      heartbeatIntervalSeconds: this.config.edge.heartbeatSeconds,
      // Module 13: the agent pins this key and verifies every remote command against it.
      commandSigningKey: signing,
    });
  }

  private async heartbeat(fp: Buffer, input: unknown, res: ServerResponse) {
    const p = heartbeatSchema.safeParse(input);
    if (!p.success) return this.send(res, 400, { error: 'invalid-request', message: 'The heartbeat is malformed.' });
    const r = await this.db.unscoped((q) => q.one<{ result: string }>('SELECT * FROM agent_heartbeat($1, $2)', [fp, p.data.agentVersion]));
    if (r.result !== 'ok') return this.fail(res, r.result);
    const who = await this.db.unscoped((q) => q.one<{ organization_id: string; deployment_id: string }>('SELECT organization_id, deployment_id FROM agent_identify($1)', [fp]));
    await this.health.afterHeartbeat(who.organization_id, who.deployment_id);
    const policy = await this.db.tenant({ orgId: who.organization_id, scopeAll: true }, (q) => this.health.policyIn(q, who.organization_id));
    // Module 13: open, unexpired commands ride along (marked delivered); the agent verifies each signature itself.
    const commands = await this.commands.fetchForAgent(fp);
    const signing = await this.commands.signingKey();
    // Module 16: every heartbeat renews the license token (or says why it cannot).
    const license = await this.db.tenant({ orgId: who.organization_id, scopeAll: true }, (q) => this.licenseTokens.renewalFor(q, who.deployment_id, null));
    return this.send(res, 200, { status: 'ok', heartbeatIntervalSeconds: policy.heartbeatIntervalSeconds, serverTime: new Date().toISOString(), commands, commandSigningKey: signing, license });
  }

  /** The agent's answer to a command it executed (or staged for the host operator). */
  private async commandResult(fp: Buffer, input: unknown, ip: string | null, res: ServerResponse) {
    const p = commandResultSchema.safeParse(input);
    if (!p.success) return this.send(res, 400, { error: 'invalid-request', message: 'The command result is malformed.' });
    const r = await this.commands.recordResult(fp, p.data, ip);
    if (r.result !== 'ok') return this.fail(res, r.result);
    this.logger.log({ msg: 'Remote command result', commandId: p.data.commandId, type: r.commandType, status: p.data.status, code: p.data.code }, 'AgentGateway');
    return this.send(res, 200, { status: 'ok' });
  }

  /** A batch of allow-listed reports from the agent's outbox. Each report is validated against its strict schema. */
  private async reports(fp: Buffer, input: unknown, ip: string | null, res: ServerResponse) {
    const who = await this.db.unscoped((q) =>
      q.one<{ result: string; organization_id: string; deployment_id: string; installation_id: string }>('SELECT * FROM agent_identify($1)', [fp]),
    );
    if (who.result !== 'ok') return this.fail(res, who.result);
    try {
      const r = await this.health.ingest(who.organization_id, who.deployment_id, who.installation_id, input, ip);
      return this.send(res, r.rejected.length && !r.accepted ? 400 : 200, { accepted: r.accepted, rejected: r.rejected, healthState: r.evaluation.state });
    } catch (err) {
      if (err instanceof AppError) return this.send(res, err.getStatus(), { error: err.problemType, message: err.message });
      throw err;
    }
  }

  private async renew(fp: Buffer, input: unknown, ip: string | null, res: ServerResponse) {
    const p = renewSchema.safeParse(input);
    if (!p.success) return this.send(res, 400, { error: 'invalid-request', message: 'The renewal request is malformed.' });
    const who = await this.db.unscoped((q) =>
      q.one<{ result: string; deployment_id: string; deployment_code: string; installation_id: string }>('SELECT * FROM agent_identify($1)', [fp]),
    );
    if (who.result !== 'ok') return this.fail(res, who.result);
    let cert;
    try {
      cert = await this.pki.issueAgentCertificate(p.data.csr, { deploymentId: who.deployment_id, deploymentCode: who.deployment_code, installationId: who.installation_id });
    } catch (err) {
      if (err instanceof CsrRejected) return this.send(res, 400, { error: err.code, message: err.message });
      throw err;
    }
    const r = await this.db.unscoped((q) =>
      q.one<{ result: string }>('SELECT * FROM agent_renew($1, $2, $3, $4, $5, $6, $7)', [fp, cert.serial, cert.fingerprint, cert.subject, cert.notBefore, cert.notAfter, ip]),
    );
    if (r.result !== 'ok') return this.fail(res, r.result);
    return this.send(res, 200, { certificate: cert.pem, serial: cert.serial, notAfter: cert.notAfter.toISOString() });
  }
}
