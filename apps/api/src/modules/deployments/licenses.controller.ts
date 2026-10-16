import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type LicenseAction,
  licenseActionSchema,
  type LicenseCreate,
  licenseCreateSchema,
  type LicenseDetail,
  type LicenseListQuery,
  licenseListQuerySchema,
  type LicenseStats,
  type LicenseSummary,
  type LicenseUpdate,
  licenseUpdateSchema,
  type Paged,
} from '@psacc/contracts';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { LicensesService } from './licenses.service.js';

const uuid = new ParseUUIDPipe();

/** Licenses (Module 14): per-client entitlements with their own identifiers, terms and deployment limits. */
@ApiTags('licenses')
@ApiCookieAuth('session')
@Controller('licenses')
export class LicensesController {
  constructor(@Inject(LicensesService) private readonly licenses: LicensesService) {}

  @Get()
  @RequirePermissions('licenses.read')
  @ApiOperation({ summary: 'List licenses (search, status, client, expiring within N days).' })
  @ApiZodQuery(licenseListQuerySchema)
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(licenseListQuerySchema)) q: LicenseListQuery): Promise<Paged<LicenseSummary>> {
    return this.licenses.list(auth, q);
  }

  @Get('stats')
  @RequirePermissions('licenses.read')
  @ApiOperation({ summary: 'License counts per status and the number expiring soon.' })
  stats(@CurrentAuth() auth: AuthContext): Promise<LicenseStats> {
    return this.licenses.stats(auth);
  }

  @Post()
  @RequirePermissions('licenses.manage')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a license for a client.' })
  @ApiZodBody(licenseCreateSchema)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(licenseCreateSchema)) dto: LicenseCreate, @CurrentRequest() req: AppRequest): Promise<LicenseDetail> {
    return this.licenses.create(auth, dto, requestMeta(req));
  }

  @Get(':id')
  @RequirePermissions('licenses.read')
  @ApiOperation({ summary: 'License detail with its deployments.' })
  detail(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<LicenseDetail> {
    return this.licenses.detail(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('licenses.manage')
  @ApiOperation({ summary: 'Update the plan name, term, deployment limit or notes (optimistic version).' })
  @ApiZodBody(licenseUpdateSchema)
  update(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(licenseUpdateSchema)) dto: LicenseUpdate, @CurrentRequest() req: AppRequest): Promise<LicenseDetail> {
    return this.licenses.update(auth, id, dto, requestMeta(req));
  }

  @Post(':id/suspend')
  @RequirePermissions('licenses.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend an active license (its deployments can no longer get packages or enroll).' })
  @ApiZodBody(licenseActionSchema)
  suspend(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(licenseActionSchema)) dto: LicenseAction, @CurrentRequest() req: AppRequest): Promise<LicenseDetail> {
    return this.licenses.suspend(auth, id, dto, requestMeta(req));
  }

  @Post(':id/resume')
  @RequirePermissions('licenses.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resume a suspended license.' })
  @ApiZodBody(licenseActionSchema)
  resume(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(licenseActionSchema)) dto: LicenseAction, @CurrentRequest() req: AppRequest): Promise<LicenseDetail> {
    return this.licenses.resume(auth, id, dto, requestMeta(req));
  }

  @Post(':id/revoke')
  @RequirePermissions('licenses.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a license permanently.' })
  @ApiZodBody(licenseActionSchema)
  revoke(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(licenseActionSchema)) dto: LicenseAction, @CurrentRequest() req: AppRequest): Promise<LicenseDetail> {
    return this.licenses.revoke(auth, id, dto, requestMeta(req));
  }
}
