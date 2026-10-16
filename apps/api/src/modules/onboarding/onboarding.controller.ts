import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  completeDraftSchema,
  DATA_STEPS,
  type OnboardingDraftDto,
  type OnboardingDraftSummary,
  saveStepSchema,
} from '@psacc/contracts';
import { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ZodPipe } from '../../common/zod.js';
import { OnboardingService } from './onboarding.service.js';

const uuid = new ParseUUIDPipe();
const stepParam = new ZodPipe(z.enum(DATA_STEPS));
const listQuery = z.strictObject({ status: z.enum(['in_progress', 'completed', 'abandoned']).default('in_progress') });

@ApiTags('onboarding')
@ApiCookieAuth('session')
@Controller('onboarding/drafts')
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Post()
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Start a new onboarding draft (server-side wizard progress).' })
  create(@CurrentAuth() auth: AuthContext, @CurrentRequest() req: AppRequest): Promise<OnboardingDraftDto> {
    return this.onboarding.create(auth, requestMeta(req));
  }

  @Get()
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Onboarding drafts of the organization (default: in progress).' })
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>): Promise<OnboardingDraftSummary[]> {
    return this.onboarding.list(auth, q.status);
  }

  @Get(':id')
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Draft with all saved step data, completed steps and version.' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<OnboardingDraftDto> {
    return this.onboarding.get(auth, id);
  }

  @Put(':id/steps/:step')
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Validate and save one wizard step. Requires the draft `version`; returns the updated draft.' })
  @ApiZodBody(saveStepSchema)
  saveStep(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('step', stepParam) step: (typeof DATA_STEPS)[number],
    @Body(new ZodPipe(saveStepSchema)) dto: z.infer<typeof saveStepSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<OnboardingDraftDto> {
    return this.onboarding.saveStep(auth, id, step, dto.version, dto.data, requestMeta(req));
  }

  @Post(':id/abandon')
  @RequirePermissions('clients.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Abandon an in-progress draft (kept for audit).' })
  abandon(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @CurrentRequest() req: AppRequest): Promise<OnboardingDraftDto> {
    return this.onboarding.abandon(auth, id, requestMeta(req));
  }

  @Post(':id/complete')
  @RequirePermissions('clients.write', 'psa.write', 'deployments.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Create the client, contacts, PSA instance, services and draft deployment atomically. Idempotent.' })
  @ApiZodBody(completeDraftSchema)
  complete(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(completeDraftSchema)) dto: z.infer<typeof completeDraftSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<OnboardingDraftDto> {
    return this.onboarding.complete(auth, id, dto.version, requestMeta(req));
  }
}
