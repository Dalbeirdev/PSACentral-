import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AuditEventDto,
  type Paged,
  serviceCategoryCreateSchema,
  type ServiceCategoryDto,
  serviceCategoryUpdateSchema,
  serviceCreateSchema,
  type ServiceDetail,
  serviceListQuerySchema,
  serviceStatusSchema,
  type ServiceSummary,
  serviceUpdateSchema,
} from '@psacc/contracts';
import { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { ServicesService } from './services.service.js';

const uuid = new ParseUUIDPipe();
const pageQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Service catalog administration (Module 4). The catalog is per organization and database-driven;
 * `services.read` sees it, `services.write` manages it. Client assignment stays under /clients/:id/services.
 */
@ApiTags('catalog')
@ApiCookieAuth('session')
@Controller()
export class ServicesController {
  constructor(@Inject(ServicesService) private readonly services: ServicesService) {}

  @Get('services')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Service catalog with usage counts; filters (text, category, status, dependency, PSA use) run on the server.' })
  @ApiZodQuery(serviceListQuerySchema)
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(serviceListQuerySchema)) query: z.infer<typeof serviceListQuerySchema>): Promise<ServiceSummary[]> {
    return this.services.list(auth, query);
  }

  @Post('services')
  @RequirePermissions('services.write')
  @ApiOperation({ summary: 'Create a catalog service.' })
  @ApiZodBody(serviceCreateSchema)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(serviceCreateSchema)) dto: z.infer<typeof serviceCreateSchema>, @CurrentRequest() req: AppRequest): Promise<ServiceDetail> {
    return this.services.create(auth, dto, requestMeta(req));
  }

  @Get('services/:id')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Service detail: definition, requirements, dependencies, assigned clients and usage.' })
  detail(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ServiceDetail> {
    return this.services.detail(auth, id);
  }

  @Patch('services/:id')
  @RequirePermissions('services.write')
  @ApiOperation({ summary: 'Update a service (optimistic version). The key is immutable.' })
  @ApiZodBody(serviceUpdateSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(serviceUpdateSchema)) dto: z.infer<typeof serviceUpdateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<ServiceDetail> {
    return this.services.update(auth, id, dto, requestMeta(req));
  }

  @Post('services/:id/activate')
  @RequirePermissions('services.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activate a service so it can be assigned again.' })
  @ApiZodBody(serviceStatusSchema)
  activate(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(serviceStatusSchema)) dto: z.infer<typeof serviceStatusSchema>, @CurrentRequest() req: AppRequest): Promise<ServiceDetail> {
    return this.services.setActive(auth, id, true, dto.version, requestMeta(req));
  }

  @Post('services/:id/deactivate')
  @RequirePermissions('services.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Deactivate a service: existing assignments are kept, new ones refused. Defaults cannot be deactivated.' })
  @ApiZodBody(serviceStatusSchema)
  deactivate(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(serviceStatusSchema)) dto: z.infer<typeof serviceStatusSchema>, @CurrentRequest() req: AppRequest): Promise<ServiceDetail> {
    return this.services.setActive(auth, id, false, dto.version, requestMeta(req));
  }

  @Get('services/:id/activity')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Audit events for this service, including client assignments that involved it.' })
  activity(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Query(new ZodPipe(pageQuery)) q: z.infer<typeof pageQuery>): Promise<Paged<AuditEventDto>> {
    return this.services.activity(auth, id, q.page, q.pageSize);
  }

  @Get('service-categories')
  @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Service categories with counts.' })
  categories(@CurrentAuth() auth: AuthContext): Promise<ServiceCategoryDto[]> {
    return this.services.categories(auth);
  }

  @Post('service-categories')
  @RequirePermissions('services.write')
  @ApiOperation({ summary: 'Create a category.' })
  @ApiZodBody(serviceCategoryCreateSchema)
  createCategory(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(serviceCategoryCreateSchema)) dto: z.infer<typeof serviceCategoryCreateSchema>, @CurrentRequest() req: AppRequest): Promise<ServiceCategoryDto> {
    return this.services.createCategory(auth, dto, requestMeta(req));
  }

  @Patch('service-categories/:id')
  @RequirePermissions('services.write')
  @ApiOperation({ summary: 'Rename or reorder a category (optimistic version).' })
  @ApiZodBody(serviceCategoryUpdateSchema)
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(serviceCategoryUpdateSchema)) dto: z.infer<typeof serviceCategoryUpdateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<ServiceCategoryDto> {
    return this.services.updateCategory(auth, id, dto, requestMeta(req));
  }

  @Delete('service-categories/:id')
  @RequirePermissions('services.write')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an empty category.' })
  async deleteCategory(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @CurrentRequest() req: AppRequest): Promise<void> {
    await this.services.deleteCategory(auth, id, requestMeta(req));
  }
}
