import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AuditEventDto,
  deploymentPsaBindingSchema,
  integrationListQuerySchema,
  type IntegrationRow,
  type PsaConnectionTestDto,
  type Paged,
  psaInstanceCreateSchema,
  type PsaInstanceDetail,
  psaInstanceListQuerySchema,
  type PsaInstanceSummary,
  psaInstanceUpdateSchema,
  type PsaProviderDescriptor,
} from '@psacc/contracts';
import { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { PsaService } from './psa.service.js';

const uuid = new ParseUUIDPipe();
const configPreviewSchema = z.strictObject({ authMethod: z.string().max(64), config: z.record(z.string(), z.unknown()).default({}) });
const testsQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(25) });
const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@ApiTags('psa')
@ApiCookieAuth('session')
@Controller()
export class PsaController {
  constructor(@Inject(PsaService) private readonly psa: PsaService) {}

  @Get('psa-providers')
  @RequirePermissions('psa.read')
  @ApiOperation({ summary: 'Provider descriptors: configuration fields, auth methods (credential field names only), capabilities, adapter status.' })
  providers(): PsaProviderDescriptor[] {
    return this.psa.providers();
  }

  @Post('psa-providers/:key/validate')
  @RequirePermissions('psa.read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Validate a configuration with the provider adapter and preview the derived API endpoint. Stores nothing.' })
  @ApiZodBody(configPreviewSchema)
  validate(@Param('key') key: string, @Body(new ZodPipe(configPreviewSchema)) dto: z.infer<typeof configPreviewSchema>) {
    const r = this.psa.previewConfig(key, dto.authMethod, dto.config);
    return r.ok ? { ok: true, endpoint: r.endpoint, config: r.config, issues: [] } : { ok: false, endpoint: null, config: null, issues: r.issues };
  }

  @Get('psa-instances')
  @RequirePermissions('psa.read')
  @ApiOperation({ summary: 'PSA instances across the clients the caller may access (search, filters, sort, pagination).' })
  @ApiZodQuery(psaInstanceListQuerySchema)
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(psaInstanceListQuerySchema)) q: z.infer<typeof psaInstanceListQuerySchema>): Promise<Paged<PsaInstanceSummary>> {
    return this.psa.list(auth, q);
  }

  @Post('psa-instances')
  @RequirePermissions('psa.write')
  @ApiOperation({ summary: 'Create a PSA instance for a client. Configuration is validated by the provider adapter; credentials are never accepted.' })
  @ApiZodBody(psaInstanceCreateSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(psaInstanceCreateSchema)) dto: z.infer<typeof psaInstanceCreateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<PsaInstanceDetail> {
    return this.psa.create(auth, dto, requestMeta(req));
  }

  @Get('psa-instances/:id')
  @RequirePermissions('psa.read')
  @ApiOperation({ summary: 'PSA instance detail: configuration, enabled services, deployments, connection and credential status.' })
  detail(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<PsaInstanceDetail> {
    return this.psa.detail(auth, id);
  }

  @Patch('psa-instances/:id')
  @RequirePermissions('psa.write')
  @ApiOperation({ summary: 'Update configuration, enabled services or status. Requires the current `version`.' })
  @ApiZodBody(psaInstanceUpdateSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(psaInstanceUpdateSchema)) dto: z.infer<typeof psaInstanceUpdateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<PsaInstanceDetail> {
    return this.psa.update(auth, id, dto, requestMeta(req));
  }

  @Get('psa-instances/:id/activity')
  @RequirePermissions('psa.read')
  @ApiOperation({ summary: 'Audit events for this PSA instance and deployment associations to/from it.' })
  activity(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Query(new ZodPipe(pageQuery)) q: z.infer<typeof pageQuery>): Promise<Paged<AuditEventDto>> {
    return this.psa.activity(auth, id, q.page, q.pageSize);
  }

  @Get('psa-instances/:id/connection-tests')
  @RequirePermissions('psa.read')
  @ApiOperation({ summary: 'Connection tests run on the appliance(s) bound to this instance, as reported by the agent (newest first).' })
  connectionTests(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Query(new ZodPipe(testsQuery)) q: z.infer<typeof testsQuery>): Promise<PsaConnectionTestDto[]> {
    return this.psa.connectionTests(auth, id, q.limit);
  }

  @Get('integrations')
  @RequirePermissions('integrations.read')
  @ApiOperation({ summary: 'PSA connections across the fleet with what each appliance last reported (Module 11).' })
  @ApiZodQuery(integrationListQuerySchema)
  integrations(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(integrationListQuerySchema)) query: z.infer<typeof integrationListQuerySchema>): Promise<IntegrationRow[]> {
    return this.psa.integrations(auth, query);
  }

  @Put('deployments/:id/psa-instance')
  @RequirePermissions('deployments.write')
  @ApiOperation({ summary: 'Associate a deployment with another active PSA instance of the same client.' })
  @ApiZodBody(deploymentPsaBindingSchema)
  bind(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(deploymentPsaBindingSchema)) dto: z.infer<typeof deploymentPsaBindingSchema>,
    @CurrentRequest() req: AppRequest,
  ) {
    return this.psa.bindDeployment(auth, id, dto.psaInstanceId, requestMeta(req));
  }
}
