import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type DeploymentHealthDto, type FleetHealthDto, fleetHealthQuerySchema, type HealthPolicy, healthPolicySchema } from '@psacc/contracts';
import type { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { HealthService } from './health.service.js';

const uuid = new ParseUUIDPipe();

@ApiTags('health')
@ApiCookieAuth('session')
@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get('monitoring/fleet')
  @RequirePermissions('health.read')
  @ApiOperation({ summary: 'Fleet health: every deployment with its evaluated state, last heartbeat and latest measured resources.' })
  @ApiZodQuery(fleetHealthQuerySchema)
  fleet(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(fleetHealthQuerySchema)) q: z.infer<typeof fleetHealthQuerySchema>): Promise<FleetHealthDto> {
    return this.health.fleet(auth, q);
  }

  @Get('monitoring/policy')
  @RequirePermissions('health.read')
  @ApiOperation({ summary: 'The organization’s health policy: heartbeat interval, offline threshold and resource thresholds.' })
  policy(@CurrentAuth() auth: AuthContext): Promise<HealthPolicy> {
    return this.health.policy(auth);
  }

  @Put('monitoring/policy')
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Update the health policy. Every live deployment is re-evaluated immediately.' })
  @ApiZodBody(healthPolicySchema)
  updatePolicy(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(healthPolicySchema)) dto: HealthPolicy, @CurrentRequest() req: AppRequest): Promise<HealthPolicy> {
    return this.health.updatePolicy(auth, dto, requestMeta(req));
  }

  @Get('deployments/:id/health')
  @RequirePermissions('health.read')
  @ApiOperation({ summary: 'A deployment’s health: findings, latest reports per type, resource history, heartbeats and state timeline.' })
  deployment(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<DeploymentHealthDto> {
    return this.health.deployment(auth, id);
  }
}
