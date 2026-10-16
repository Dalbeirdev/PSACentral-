import { Body, Controller, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type RetentionPolicy, type RetentionPolicyDto, type RetentionPurgeResult, retentionPolicySchema } from '@psacc/contracts';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ZodPipe } from '../../common/zod.js';
import { RetentionService } from './retention.service.js';

/** Data retention for decommissioned deployments (Module 15): organization policy, statistics and an explicit purge run. */
@ApiTags('settings')
@ApiCookieAuth('session')
@Controller('settings/retention')
export class RetentionController {
  constructor(@Inject(RetentionService) private readonly retention: RetentionService) {}

  @Get()
  @RequirePermissions('settings.read')
  @ApiOperation({ summary: 'The organization’s retention policy for decommissioned deployments, with purge statistics.' })
  policy(@CurrentAuth() auth: AuthContext): Promise<RetentionPolicyDto> {
    return this.retention.policy(auth);
  }

  @Put()
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Update the retention period (7–3650 days). Audited.' })
  @ApiZodBody(retentionPolicySchema)
  update(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(retentionPolicySchema)) dto: RetentionPolicy, @CurrentRequest() req: AppRequest): Promise<RetentionPolicyDto> {
    return this.retention.updatePolicy(auth, dto, requestMeta(req));
  }

  @Post('purge')
  @RequirePermissions('settings.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Purge the metadata of every deployment whose retention period has ended, now instead of at the next hourly sweep.' })
  purge(@CurrentAuth() auth: AuthContext, @CurrentRequest() req: AppRequest): Promise<RetentionPurgeResult> {
    return this.retention.purgeNow(auth, requestMeta(req));
  }
}
