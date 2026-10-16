import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  agentCertificateRevokeSchema,
  type AuditEventDto,
  deploymentCreateSchema,
  type DeploymentDecommission,
  deploymentDecommissionSchema,
  type DeploymentDetail,
  type DeploymentRemovalResult,
  type DeploymentRemove,
  deploymentRemoveSchema,
  deploymentListQuerySchema,
  type DeploymentStats,
  type DeploymentSuspend,
  deploymentSuspendSchema,
  type DeploymentSummary,
  type EdgeImageInfo,
  deploymentUpdateSchema,
  packageGenerateSchema,
  packageRevokeSchema,
  type Paged,
} from '@psacc/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { packageRateLimit } from '../../config/rate-limits.js';
import { DeploymentsService } from './deployments.service.js';

const uuid = new ParseUUIDPipe();
const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@ApiTags('deployments')
@ApiCookieAuth('session')
@Controller('deployments')
export class DeploymentsController {
  constructor(@Inject(DeploymentsService) private readonly deployments: DeploymentsService) {}

  @Get()
  @RequirePermissions('deployments.read')
  @ApiOperation({ summary: 'Deployments across the clients the caller may access (search, filters, sort, pagination).' })
  @ApiZodQuery(deploymentListQuerySchema)
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(deploymentListQuerySchema)) q: z.infer<typeof deploymentListQuerySchema>): Promise<Paged<DeploymentSummary>> {
    return this.deployments.list(auth, q);
  }

  @Get('edge-image')
  @RequirePermissions('deployments.read')
  @ApiOperation({ summary: 'The standard PSA Edge image packages reference, and how many deployments use each version.' })
  edgeImage(@CurrentAuth() auth: AuthContext): Promise<EdgeImageInfo> {
    return this.deployments.edgeImage(auth);
  }

  @Get('stats')
  @RequirePermissions('deployments.read')
  @ApiOperation({ summary: 'Deployment counts per lifecycle state.' })
  stats(@CurrentAuth() auth: AuthContext): Promise<DeploymentStats> {
    return this.deployments.stats(auth);
  }

  @Post()
  @RequirePermissions('deployments.write')
  @ApiOperation({ summary: 'Create a deployment record for a client (lifecycle: draft, no package yet).' })
  @ApiZodBody(deploymentCreateSchema)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(deploymentCreateSchema)) dto: z.infer<typeof deploymentCreateSchema>, @CurrentRequest() req: AppRequest): Promise<DeploymentDetail> {
    return this.deployments.create(auth, dto, requestMeta(req));
  }

  @Get(':id')
  @RequirePermissions('deployments.read')
  @ApiOperation({ summary: 'Deployment detail: identity, lifecycle, PSA, services, packages (metadata only) and readiness checks.' })
  detail(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<DeploymentDetail> {
    return this.deployments.detail(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('deployments.write')
  @ApiOperation({ summary: 'Change PSA instance or target platform. Only while no package exists. Requires the current `version`.' })
  @ApiZodBody(deploymentUpdateSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(deploymentUpdateSchema)) dto: z.infer<typeof deploymentUpdateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<DeploymentDetail> {
    return this.deployments.update(auth, id, dto, requestMeta(req));
  }

  @Post(':id/packages')
  @RequirePermissions('deployments.package.generate')
  @Throttle({ default: packageRateLimit })
  @ApiOperation({ summary: 'Generate the deployment package: installation ID, single-use enrollment token, configuration, Compose files, scripts and docs (ZIP).' })
  @ApiZodBody(packageGenerateSchema)
  generate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(packageGenerateSchema)) dto: z.infer<typeof packageGenerateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<DeploymentDetail> {
    return this.deployments.generate(auth, id, dto, requestMeta(req));
  }

  @Post(':id/packages/:packageId/download')
  @RequirePermissions('deployments.package.generate')
  @Throttle({ default: packageRateLimit })
  @HttpCode(200)
  @ApiProduces('application/zip')
  @ApiOperation({ summary: 'Download a usable package. POST (with CSRF) because it is recorded and contains a single-use token.' })
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('packageId', uuid) packageId: string,
    @CurrentRequest() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.deployments.download(auth, id, packageId, requestMeta(req));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-SHA256', file.sha256);
    return new StreamableFile(file.archive, { type: 'application/zip', disposition: `attachment; filename="${file.fileName}"`, length: file.archive.length });
  }

  @Post(':id/packages/:packageId/revoke')
  @RequirePermissions('deployments.package.generate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a usable package and its enrollment token. The deployment returns to draft.' })
  @ApiZodBody(packageRevokeSchema)
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('packageId', uuid) packageId: string,
    @Body(new ZodPipe(packageRevokeSchema)) dto: z.infer<typeof packageRevokeSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<DeploymentDetail> {
    return this.deployments.revoke(auth, id, packageId, dto.reason, requestMeta(req));
  }

  @Post(':id/agent-certificate/revoke')
  @RequirePermissions('deployments.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke the agent machine certificate. The gateway refuses it immediately; the deployment returns to draft for re-enrollment.' })
  @ApiZodBody(agentCertificateRevokeSchema)
  revokeCertificate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(agentCertificateRevokeSchema)) dto: z.infer<typeof agentCertificateRevokeSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<DeploymentDetail> {
    return this.deployments.revokeAgentCertificate(auth, id, dto.reason, requestMeta(req));
  }

  @Post(':id/suspend')
  @RequirePermissions('deployments.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend the deployment (Module 14): reversible; an enrolled appliance pauses PSA work via a signed command.' })
  @ApiZodBody(deploymentSuspendSchema)
  suspend(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(deploymentSuspendSchema)) dto: DeploymentSuspend, @CurrentRequest() req: AppRequest): Promise<DeploymentDetail> {
    return this.deployments.suspend(auth, id, dto.reason, requestMeta(req));
  }

  @Post(':id/decommission')
  @RequirePermissions('deployments.decommission')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decommission the deployment (Module 15): retires its identity on the Control Plane; final. The deployment ID must be typed to confirm.' })
  @ApiZodBody(deploymentDecommissionSchema)
  decommission(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(deploymentDecommissionSchema)) dto: DeploymentDecommission, @CurrentRequest() req: AppRequest): Promise<DeploymentDetail> {
    return this.deployments.decommission(auth, id, dto, requestMeta(req));
  }

  @Delete(':id')
  @RequirePermissions('deployments.decommission')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a decommissioned deployment record and its retained metadata (audited). The deployment ID must be typed to confirm.' })
  @ApiZodBody(deploymentRemoveSchema)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(deploymentRemoveSchema)) dto: DeploymentRemove, @CurrentRequest() req: AppRequest): Promise<DeploymentRemovalResult> {
    return this.deployments.remove(auth, id, dto.confirmCode, requestMeta(req));
  }

  @Post(':id/resume')
  @RequirePermissions('deployments.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resume a suspended deployment (needs an active license).' })
  @ApiZodBody(deploymentSuspendSchema)
  resume(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(deploymentSuspendSchema)) dto: DeploymentSuspend, @CurrentRequest() req: AppRequest): Promise<DeploymentDetail> {
    return this.deployments.resume(auth, id, dto.reason, requestMeta(req));
  }

  @Get(':id/activity')
  @RequirePermissions('deployments.read')
  @ApiOperation({ summary: 'Audit events for this deployment.' })
  activity(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Query(new ZodPipe(pageQuery)) q: z.infer<typeof pageQuery>): Promise<Paged<AuditEventDto>> {
    return this.deployments.activity(auth, id, q.page, q.pageSize);
  }
}
