import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  DATA_STEPS,
  type DataStepKey,
  type DraftStatus,
  ONBOARDING_STEPS,
  type OnboardingDraftData,
  type OnboardingDraftDto,
  type OnboardingDraftSummary,
  type OnboardingResult,
  type OnboardingStepKey,
  STEP_SCHEMAS,
} from '@psacc/contracts';
import type { AuthContext, RequestMeta } from '../../common/auth-context.js';
import { AppError } from '../../common/problem.filter.js';
import { ValidationFailedException } from '../../common/zod.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { PsaService } from '../psa/psa.service.js';

type Row = Record<string, unknown>;

const NEXT_STEP: Record<OnboardingStepKey, OnboardingStepKey> = Object.fromEntries(
  ONBOARDING_STEPS.map((s, i) => [s.key, ONBOARDING_STEPS[Math.min(i + 1, ONBOARDING_STEPS.length - 1)]!.key]),
) as Record<OnboardingStepKey, OnboardingStepKey>;

/** Records created by completing a draft; creating them requires all three permissions. */
export const COMPLETE_PERMISSIONS = ['clients.write', 'psa.write', 'deployments.write'] as const;

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(PsaService) private readonly psa: PsaService,
  ) {}

  private toDto(r: Row): OnboardingDraftDto {
    return {
      id: r.id as string,
      status: r.status as DraftStatus,
      currentStep: r.current_step as OnboardingStepKey,
      completedSteps: r.completed_steps as DataStepKey[],
      data: (r.data as OnboardingDraftData) ?? {},
      version: r.version as number,
      result: (r.result as OnboardingResult | null) ?? null,
      createdBy: { id: r.created_by as string, displayName: r.created_by_name as string },
      updatedBy: r.updated_by ? { id: r.updated_by as string, displayName: r.updated_by_name as string } : null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
      completedAt: (r.completed_at as Date | null)?.toISOString() ?? null,
    };
  }

  private async load(q: Queryable, id: string, lock = false): Promise<Row> {
    const r = await q.maybeOne<Row>(
      `SELECT d.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
       FROM onboarding_drafts d JOIN users cu ON cu.id = d.created_by LEFT JOIN users uu ON uu.id = d.updated_by
       WHERE d.id = $1 ${lock ? 'FOR UPDATE OF d' : ''}`,
      [id],
    );
    if (!r) throw new AppError(404, 'not-found', 'Onboarding draft not found.');
    return r;
  }

  private async actor(q: Queryable, auth: AuthContext) {
    return (await q.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [auth.userId])).email;
  }

  async create(auth: AuthContext, meta: RequestMeta): Promise<OnboardingDraftDto> {
    return this.db.tenant(auth, async (q) => {
      const id = randomUUID();
      await q.query('INSERT INTO onboarding_drafts (id, organization_id, created_by, updated_by) VALUES ($1, $2, $3, $3)', [id, auth.orgId, auth.userId]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'onboarding.draft.created', outcome: 'success', actorUserId: auth.userId,
        actorDisplay: await this.actor(q, auth), meta, targetType: 'onboarding_draft', targetId: id,
      });
      return this.toDto(await this.load(q, id));
    });
  }

  async list(auth: AuthContext, status: DraftStatus): Promise<OnboardingDraftSummary[]> {
    return this.db.tenant(auth, async (q) => {
      const rows = await q.query<Row>(
        `SELECT d.id, d.status, d.current_step, d.completed_steps, d.updated_at,
                d.data #>> '{client,company,displayName}' AS client_name, u.display_name AS created_by_name
         FROM onboarding_drafts d JOIN users u ON u.id = d.created_by
         WHERE d.status = $1 ORDER BY d.updated_at DESC LIMIT 100`,
        [status],
      );
      return rows.map((r) => ({
        id: r.id as string, status: r.status as DraftStatus, currentStep: r.current_step as OnboardingStepKey,
        completedSteps: r.completed_steps as DataStepKey[], clientName: (r.client_name as string | null) ?? null,
        createdBy: r.created_by_name as string, updatedAt: (r.updated_at as Date).toISOString(),
      }));
    });
  }

  async get(auth: AuthContext, id: string): Promise<OnboardingDraftDto> {
    return this.db.tenant(auth, async (q) => this.toDto(await this.load(q, id)));
  }

  /** Validates and stores one step. Business rules beyond the schema are checked against the database. */
  async saveStep(auth: AuthContext, id: string, step: DataStepKey, version: number, raw: unknown, meta: RequestMeta): Promise<OnboardingDraftDto> {
    const parsed = STEP_SCHEMAS[step].safeParse(raw ?? {});
    if (!parsed.success) {
      throw new ValidationFailedException(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return this.db.tenant(auth, async (q) => {
      const draft = await this.load(q, id, true);
      if (draft.status !== 'in_progress') throw new AppError(409, 'draft-closed', `This onboarding is ${draft.status === 'completed' ? 'already completed' : 'abandoned'} and can no longer be edited.`);
      if (draft.version !== version) throw new AppError(409, 'stale-version', 'This draft was saved elsewhere (another tab or user). Reload to continue from the latest version.');
      const data = { ...((draft.data as OnboardingDraftData) ?? {}) } as Record<string, unknown>;
      let completed = new Set(draft.completed_steps as DataStepKey[]);
      const value = parsed.data as Record<string, unknown>;

      if (step === 'client') {
        const v = parsed.data as NonNullable<OnboardingDraftData['client']>;
        await this.clients.assertActiveUsers(q, [v.management.accountManagerUserId, v.management.technicalOwnerUserId], [
          'management.accountManagerUserId', 'management.technicalOwnerUserId',
        ]);
        const taken = await this.clients.referenceTakenBy(q, auth, v.company.clientReference);
        if (taken) throw new ValidationFailedException([{ path: 'company.clientReference', message: `This reference is already used by ${taken.code}.` }]);
      }
      if (step === 'psa-provider') {
        const providerKey = (parsed.data as { providerKey: string }).providerKey;
        const provider = await q.maybeOne('SELECT 1 FROM psa_providers WHERE key = $1 AND is_enabled', [providerKey]);
        if (!provider) throw new ValidationFailedException([{ path: 'providerKey', message: 'This PSA provider is not available.' }]);
        const prev = data['psa-provider'] as { providerKey?: string } | undefined;
        if (prev?.providerKey && prev.providerKey !== providerKey) {
          // Provider-specific configuration no longer applies.
          delete data['psa-config'];
          completed.delete('psa-config');
        }
      }
      if (step === 'psa-config') {
        const providerKey = (data['psa-provider'] as { providerKey?: string } | undefined)?.providerKey;
        if (!providerKey) throw new AppError(409, 'step-order', 'Choose a PSA provider first.');
        // Provider-specific rules live in the adapter; the normalized configuration is what gets stored.
        const v = parsed.data as { authMethod: string; config: unknown };
        const { config } = this.psa.validateConfig(providerKey, v.authMethod, v.config);
        (value as { config: unknown }).config = config;
      }
      if (step === 'services') {
        const v = parsed.data as { serviceIds: string[]; config: Record<string, Record<string, unknown>> };
        await this.clients.assertActiveServices(q, v.serviceIds);
        // Normalized values are what gets stored; required settings must be present before the step counts as complete.
        (value as { config: unknown }).config = Object.fromEntries(await this.clients.serviceConfigsFor(q, v.serviceIds, v.config));
      }

      data[step] = value;
      completed.add(step);
      completed = new Set(DATA_STEPS.filter((s) => completed.has(s)));
      const current = draft.current_step as OnboardingStepKey;
      const stepIndex = ONBOARDING_STEPS.findIndex((s) => s.key === step);
      const currentIndex = ONBOARDING_STEPS.findIndex((s) => s.key === current);
      const nextStep = stepIndex >= currentIndex ? NEXT_STEP[step] : current;

      await q.query(
        `UPDATE onboarding_drafts SET data = $2, completed_steps = $3, current_step = $4, version = version + 1, updated_by = $5
         WHERE id = $1`,
        [id, JSON.stringify(data), [...completed], nextStep, auth.userId],
      );
      return this.toDto(await this.load(q, id));
    });
  }

  async abandon(auth: AuthContext, id: string, meta: RequestMeta): Promise<OnboardingDraftDto> {
    return this.db.tenant(auth, async (q) => {
      const draft = await this.load(q, id, true);
      if (draft.status !== 'in_progress') throw new AppError(409, 'draft-closed', 'Only an in-progress onboarding can be abandoned.');
      await q.query(`UPDATE onboarding_drafts SET status = 'abandoned', version = version + 1, updated_by = $2 WHERE id = $1`, [id, auth.userId]);
      await this.audit.write(q, {
        orgId: auth.orgId, action: 'onboarding.draft.abandoned', outcome: 'success', actorUserId: auth.userId,
        actorDisplay: await this.actor(q, auth), meta, targetType: 'onboarding_draft', targetId: id,
        targetDisplay: (draft.data as OnboardingDraftData).client?.company.displayName,
      });
      return this.toDto(await this.load(q, id));
    });
  }

  /**
   * Creates every record in one transaction: client (CL-), contacts, PSA instance (PSA-, untested),
   * service assignments and a deployment record (DEP-) in the `draft` lifecycle state.
   * Idempotent: completing an already-completed draft returns the original result.
   */
  async complete(auth: AuthContext, id: string, version: number, meta: RequestMeta): Promise<OnboardingDraftDto> {
    const missing = COMPLETE_PERMISSIONS.filter((p) => !auth.permissions.has(p));
    if (missing.length) throw new AppError(403, 'forbidden', `Creating the client and deployment requires: ${missing.join(', ')}.`);

    return this.db.tenant(auth, async (q) => {
      const draft = await this.load(q, id, true);
      if (draft.status === 'completed') return this.toDto(draft);
      if (draft.status !== 'in_progress') throw new AppError(409, 'draft-closed', 'This onboarding was abandoned.');
      if (draft.version !== version) throw new AppError(409, 'stale-version', 'This draft changed since you reviewed it. Reload and review again.');

      const data = draft.data as OnboardingDraftData;
      const missingSteps = DATA_STEPS.filter((s) => !(draft.completed_steps as string[]).includes(s));
      if (missingSteps.length) throw new AppError(422, 'incomplete-draft', `Complete these steps first: ${missingSteps.join(', ')}.`);
      // Re-validate everything: stored data may be stale (e.g. a service was deactivated since).
      for (const s of DATA_STEPS) {
        const r = STEP_SCHEMAS[s].safeParse(data[s]);
        if (!r.success) throw new AppError(422, 'invalid-draft', `Step "${s}" is no longer valid. Open it and save it again.`);
      }
      const client = data.client!;
      const provider = data['psa-provider']!;
      const psa = data['psa-config']!;
      const services = data.services!;
      const dep = data.deployment!;
      await this.clients.assertActiveUsers(q, [client.management.accountManagerUserId, client.management.technicalOwnerUserId], [
        'management.accountManagerUserId', 'management.technicalOwnerUserId',
      ]);
      const chosen = await this.clients.assertActiveServices(q, services.serviceIds);
      const taken = await this.clients.referenceTakenBy(q, auth, client.company.clientReference);
      if (taken) throw new AppError(409, 'duplicate-reference', `The client reference is now used by ${taken.code}. Change it in step 1.`);

      const clientId = randomUUID();
      const { company: c, management: m } = client;
      try {
        await q.query(
          `INSERT INTO clients (id, organization_id, code, client_reference, legal_name, display_name, business_type, country_code, state_region,
             city, timezone, website, status, service_status, account_manager_user_id, technical_owner_user_id, onboarding_date,
             contract_start_date, contract_end_date, internal_notes, created_by)
           VALUES ($1, $2, next_org_code('client', 'CL'), $3, $4, $5, $6, $7, $8, $9, $10, $11, 'onboarding', 'in_progress', $12, $13,
             coalesce($14::date, current_date), $15, $16, $17, $18)`,
          [clientId, auth.orgId, c.clientReference, c.legalName, c.displayName, c.businessType, c.countryCode, c.stateRegion ?? null,
            c.city ?? null, c.timezone, c.website ?? null, m.accountManagerUserId ?? null, m.technicalOwnerUserId ?? null,
            m.onboardingDate ?? null, m.contractStartDate ?? null, m.contractEndDate ?? null, m.internalNotes ?? null, auth.userId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new AppError(409, 'duplicate-reference', 'The client reference is already in use. Change it in step 1.');
        throw err;
      }
      // A creator limited to assigned clients keeps access to the client they onboarded.
      if (!auth.scopeAll) {
        await q.query('INSERT INTO user_client_assignments (organization_id, user_id, client_id, assigned_by) VALUES ($1, $2, $3, $2)', [auth.orgId, auth.userId, clientId]);
      }
      await this.clients.insertContacts(q, auth.orgId, clientId, client.contacts, auth.userId);

      const configs = await this.clients.serviceConfigsFor(q, services.serviceIds, services.config ?? {});
      for (const s of chosen) {
        await q.query('INSERT INTO client_services (organization_id, client_id, service_id, config, enabled_by) VALUES ($1, $2, $3, $4, $5)', [
          auth.orgId, clientId, s.id, JSON.stringify(configs.get(s.id) ?? {}), auth.userId,
        ]);
      }
      // Services that work through the PSA (e.g. Help Desk) are enabled on the new instance.
      const psaServiceIds = (
        await q.query<{ id: string }>('SELECT id FROM services WHERE id = ANY($1::uuid[]) AND requires_psa', [chosen.map((s) => s.id)])
      ).map((r) => r.id);
      let psaId: string;
      try {
        psaId = (
          await this.psa.insertInstance(q, auth, {
            clientId, providerKey: provider.providerKey, displayName: psa.displayName, authMethod: psa.authMethod,
            config: psa.config, notes: psa.notes, enabledServiceIds: psaServiceIds,
          })
        ).id;
      } catch (err) {
        if (err instanceof ValidationFailedException) throw new AppError(422, 'invalid-draft', 'The PSA configuration (step 3) is no longer valid. Open it and save it again.');
        throw err;
      }
      // Module 14: a new client gets its first license (one deployment, the contract term) so that the package in
      // step 8 and the enrollment are entitled; operators adjust it under Licenses.
      const licenseId = randomUUID();
      await q.query(
        `INSERT INTO licenses (id, organization_id, client_id, code, display_name, starts_at, ends_at, max_deployments, notes, created_by, updated_by)
         VALUES ($1, $2, $3, next_org_code('license', 'LIC'), $4, coalesce($5::date, current_date), $6::date, 1, $7, $8, $8)`,
        [licenseId, auth.orgId, clientId, `${c.displayName} — initial license`, m.contractStartDate ?? null, m.contractEndDate ?? null,
          'Created by the onboarding wizard for the first deployment.', auth.userId],
      );
      const depId = randomUUID();
      await q.query(
        `INSERT INTO deployments (id, organization_id, client_id, psa_instance_id, license_id, code, target_environment, target_os, target_arch,
           host_label, lifecycle_state, health_state, created_by)
         VALUES ($1, $2, $3, $4, $5, next_org_code('deployment', 'DEP'), $6, $7, $8, $9, 'draft', 'unknown', $10)`,
        [depId, auth.orgId, clientId, psaId, licenseId, dep.targetEnvironment, dep.targetOs, dep.targetArch, dep.hostLabel ?? null, auth.userId],
      );
      const codes = await q.one<{ client: string; psa: string; dep: string; lic: string }>(
        `SELECT (SELECT code FROM clients WHERE id = $1) AS client, (SELECT code FROM psa_instances WHERE id = $2) AS psa,
                (SELECT code FROM deployments WHERE id = $3) AS dep, (SELECT code FROM licenses WHERE id = $4) AS lic`,
        [clientId, psaId, depId, licenseId],
      );
      const result: OnboardingResult = {
        clientId, clientCode: codes.client, psaInstanceId: psaId, psaInstanceCode: codes.psa, deploymentId: depId, deploymentCode: codes.dep,
        licenseId, licenseCode: codes.lic, contactCount: client.contacts.length, serviceCount: chosen.length,
      };
      await q.query(
        `UPDATE onboarding_drafts SET status = 'completed', client_id = $2, result = $3, current_step = 'download',
           completed_at = now(), version = version + 1, updated_by = $4 WHERE id = $1`,
        [id, clientId, JSON.stringify(result), auth.userId],
      );
      const actorDisplay = await this.actor(q, auth);
      const base = { orgId: auth.orgId, outcome: 'success' as const, actorUserId: auth.userId, actorDisplay, meta, clientId };
      await this.audit.write(q, {
        ...base, action: 'client.onboarded', targetType: 'client', targetId: clientId, targetDisplay: c.displayName,
        metadata: { code: codes.client, draftId: id, contacts: client.contacts.length, services: chosen.map((s) => s.key) },
      });
      await this.audit.write(q, {
        ...base, action: 'psa_instance.created', targetType: 'psa_instance', targetId: psaId, targetDisplay: psa.displayName,
        metadata: { code: codes.psa, provider: provider.providerKey, connectionStatus: 'untested' },
      });
      await this.audit.write(q, {
        ...base, action: 'license.created', targetType: 'license', targetId: licenseId, targetDisplay: codes.lic,
        metadata: { code: codes.lic, startsAt: m.contractStartDate ?? null, endsAt: m.contractEndDate ?? null, maxDeployments: 1, source: 'onboarding' },
      });
      await this.audit.write(q, {
        ...base, action: 'deployment.created', targetType: 'deployment', targetId: depId, targetDisplay: codes.dep,
        metadata: { lifecycleState: 'draft', licenseId, targetEnvironment: dep.targetEnvironment, targetOs: dep.targetOs, targetArch: dep.targetArch },
      });
      return this.toDto(await this.load(q, id));
    });
  }
}
