import { Inject, Injectable } from '@nestjs/common';
import { CLIENT_DELETION_AUDIT_ACTION, type ClientDeletionResult, clientDeletionRequestSchema } from '@psacc/contracts';
import { JsonLogger } from '../../common/logger.js';
import { DatabaseService } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';

export type ClientDeletionOutcome = { ok: true; result: ClientDeletionResult } | { ok: false; status: number; code: string; message: string };

const refuse = (status: number, code: string, message: string): ClientDeletionOutcome => ({ ok: false, status, code, message });

/**
 * Module 17: a deletion requested on the appliance by the client's local administrator.
 *
 * The appliance authenticates with its machine certificate; the request must name the installation the
 * certificate was issued for. In one transaction the Control Plane deletes everything it holds about the
 * deployment (the Module 15 removal, allowed here in any lifecycle state) and writes the one audit event
 * that remains. A retry after a successful deletion finds that event by the certificate's fingerprint
 * and answers `already-deleted`, so the appliance can finish its own wipe without doubt.
 */
@Injectable()
export class ClientDeletionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  async deleteFromAppliance(fp: Buffer, input: unknown, ip: string | null): Promise<ClientDeletionOutcome> {
    const p = clientDeletionRequestSchema.safeParse(input);
    if (!p.success) return refuse(400, 'invalid-request', 'The deletion request is malformed.');
    const fpHex = fp.toString('hex');
    const who = await this.db.unscoped((q) =>
      q.one<{ result: string; organization_id: string | null; deployment_id: string | null; deployment_code: string | null; installation_id: string | null }>(
        'SELECT * FROM agent_identify($1)',
        [fp],
      ),
    );
    if (who.result === 'unknown') {
      // The certificate was deleted with the deployment: a retry of a deletion that already succeeded, or a stranger.
      const tomb = await this.tombstone(fpHex);
      if (!tomb) return refuse(401, 'unknown', 'The certificate is not known to the Control Plane.');
      return { ok: true, result: { status: 'already-deleted', deploymentCode: tomb.code, deletedAt: tomb.at, auditEventId: tomb.id, deleted: {} } };
    }
    if (who.result !== 'ok' && who.result !== 'decommissioned') {
      return refuse(403, who.result, `The certificate is ${who.result}; the deployment cannot be deleted with it.`);
    }
    if (who.installation_id !== p.data.installationId) {
      return refuse(403, 'installation-mismatch', 'The request names another installation than the certificate was issued for.');
    }
    const orgId = who.organization_id!;
    const id = who.deployment_id!;
    const { requestedBy, reason, requestedAt } = p.data;
    const result = await this.db.tenant({ orgId, scopeAll: true }, async (q): Promise<ClientDeletionResult> => {
      const d = await q.one<{ code: string; client_id: string; client_code: string; lifecycle_state: string; installation_id: string | null; license_code: string | null; decommissioned_at: Date | null }>(
        `SELECT d.code, d.client_id, c.code AS client_code, d.lifecycle_state, d.installation_id, l.code AS license_code, d.decommissioned_at
         FROM deployments d JOIN clients c ON c.id = d.client_id LEFT JOIN licenses l ON l.id = d.license_id WHERE d.id = $1`,
        [id],
      );
      const certificates = (await q.query<{ serial: string; status: string }>('SELECT serial, status FROM agent_certificates WHERE deployment_id = $1 ORDER BY issued_at', [id])).map(
        (c) => `${c.serial}:${c.status}`,
      );
      const deleted = (await q.one<{ d: Record<string, number> }>('SELECT app_remove_deployment($1, true) AS d', [id])).d;
      // Audit metadata is passed through the secret mask, which hides any key containing "token"; the count of
      // deleted enrollment tokens is not a secret, so it is recorded under a plain name.
      const auditedCounts = Object.fromEntries(Object.entries(deleted).map(([k, v]) => [k === 'enrollmentTokens' ? 'enrollments' : k, v]));
      await this.audit.write(q, {
        orgId,
        action: CLIENT_DELETION_AUDIT_ACTION,
        outcome: 'success',
        actorType: 'agent',
        actorDisplay: `Appliance ${d.code} (local administrator ${requestedBy})`,
        targetType: 'deployment',
        targetId: id,
        targetDisplay: d.code,
        clientId: d.client_id,
        meta: { ip, userAgent: 'psa-edge-agent' },
        metadata: {
          code: d.code,
          clientCode: d.client_code,
          installationId: d.installation_id,
          certificateFingerprint: fpHex,
          certificates,
          requestedBy,
          reason,
          requestedAt,
          lifecycleState: d.lifecycle_state,
          decommissionedAt: d.decommissioned_at ? d.decommissioned_at.toISOString() : null,
          licenseCode: d.license_code,
          deleted: auditedCounts,
        },
      });
      const ev = await q.one<{ id: string; occurred_at: Date }>(
        `SELECT id, occurred_at FROM audit_events WHERE action = $1 AND target_id = $2 ORDER BY occurred_at DESC LIMIT 1`,
        [CLIENT_DELETION_AUDIT_ACTION, id],
      );
      return { status: 'deleted', deploymentCode: d.code, deletedAt: ev.occurred_at.toISOString(), auditEventId: ev.id, deleted };
    });
    this.logger.warn({ msg: 'Deployment deleted by the client from its appliance', code: result.deploymentCode, requestedBy, ip, deleted: result.deleted }, 'ClientDeletion');
    return { ok: true, result };
  }

  /** The audit event of an earlier deletion by this certificate (the only trace the Control Plane keeps). */
  private async tombstone(fpHex: string): Promise<{ id: string; code: string; at: string } | null> {
    const row = await this.db.unscoped((q) =>
      q.maybeOne<{ event_id: string; occurred_at: Date; deployment_code: string | null }>('SELECT event_id, occurred_at, deployment_code FROM agent_deletion_tombstone($1)', [fpHex]),
    );
    return row ? { id: row.event_id, code: row.deployment_code ?? '', at: row.occurred_at.toISOString() } : null;
  }
}
