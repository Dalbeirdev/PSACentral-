import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AuditEventDto,
  type ClientDeploymentDto,
  type ClientDetail,
  type ClientHealthDto,
  clientListQuerySchema,
  type ClientPsaInstanceDto,
  type ClientServiceDto,
  clientServicesUpdateSchema,
  type ClientSummary,
  clientUpdateSchema,
  type ContactDto,
  contactSchema,
  duplicateCheckQuerySchema,
  type DuplicateCheckResponse,
  type Paged,
  type UserRef,
} from '@psacc/contracts';
import { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { ClientsService } from './clients.service.js';

const uuid = new ParseUUIDPipe();
const activityQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@ApiTags('clients')
@ApiCookieAuth('session')
@Controller('clients')
export class ClientsController {
  constructor(@Inject(ClientsService) private readonly clients: ClientsService) {}

  @Get()
  @RequirePermissions('clients.read')
  @ApiOperation({ summary: 'Client directory: server-side search, filters, sorting and pagination (scoped to the caller).' })
  @ApiZodQuery(clientListQuerySchema)
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(clientListQuerySchema)) q: z.infer<typeof clientListQuerySchema>): Promise<Paged<ClientSummary>> {
    return this.clients.list(auth, q);
  }

  @Get('duplicate-check')
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Checks client-reference availability and finds similarly named clients.' })
  @ApiZodQuery(duplicateCheckQuerySchema)
  duplicateCheck(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(duplicateCheckQuerySchema)) q: z.infer<typeof duplicateCheckQuerySchema>): Promise<DuplicateCheckResponse> {
    return this.clients.duplicateCheck(auth, q);
  }

  @Get(':id')
  @RequirePermissions('clients.read')
  @ApiOperation({ summary: 'Client detail with management info, primary contact, counts and assigned technicians.' })
  detail(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ClientDetail> {
    return this.clients.detail(auth, id);
  }

  @Patch(':id')
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Update company, management and status fields. Requires the current `version` (optimistic concurrency).' })
  @ApiZodBody(clientUpdateSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(clientUpdateSchema)) dto: z.infer<typeof clientUpdateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<ClientDetail> {
    return this.clients.update(auth, id, dto, requestMeta(req));
  }

  @Get(':id/contacts')
  @RequirePermissions('clients.read')
  @ApiOperation({ summary: 'Client contacts (primary first).' })
  contacts(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ContactDto[]> {
    return this.clients.contacts(auth, id);
  }

  @Post(':id/contacts')
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Add a contact. Marking it primary demotes the previous primary contact.' })
  @ApiZodBody(contactSchema)
  createContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(contactSchema)) dto: z.infer<typeof contactSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<ContactDto> {
    return this.clients.createContact(auth, id, dto, requestMeta(req));
  }

  @Put(':id/contacts/:contactId')
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Replace a contact’s details.' })
  @ApiZodBody(contactSchema)
  updateContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('contactId', uuid) contactId: string,
    @Body(new ZodPipe(contactSchema)) dto: z.infer<typeof contactSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<ContactDto> {
    return this.clients.updateContact(auth, id, contactId, dto, requestMeta(req));
  }

  @Delete(':id/contacts/:contactId')
  @RequirePermissions('clients.write')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a contact (not the primary, not the last).' })
  async deleteContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('contactId', uuid) contactId: string,
    @CurrentRequest() req: AppRequest,
  ): Promise<void> {
    await this.clients.deleteContact(auth, id, contactId, requestMeta(req));
  }

  @Get(':id/services')
  @RequirePermissions('clients.read')
  @ApiOperation({ summary: 'Services assigned to the client.' })
  services(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ClientServiceDto[]> {
    return this.clients.clientServices(auth, id);
  }

  @Put(':id/services')
  @RequirePermissions('clients.write')
  @ApiOperation({ summary: 'Replace the client’s assigned services (active catalog services only).' })
  @ApiZodBody(clientServicesUpdateSchema)
  setServices(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(clientServicesUpdateSchema)) dto: z.infer<typeof clientServicesUpdateSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<ClientServiceDto[]> {
    return this.clients.setClientServices(auth, id, dto, requestMeta(req));
  }

  @Get(':id/psa-instances')
  @RequirePermissions('clients.read', 'psa.read')
  @ApiOperation({ summary: 'PSA instances of the client (no credentials).' })
  psa(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ClientPsaInstanceDto[]> {
    return this.clients.psaInstances(auth, id);
  }

  @Get(':id/deployments')
  @RequirePermissions('clients.read', 'deployments.read')
  @ApiOperation({ summary: 'Deployments of the client with lifecycle and health state.' })
  deployments(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ClientDeploymentDto[]> {
    return this.clients.deployments(auth, id);
  }

  @Get(':id/health')
  @RequirePermissions('clients.read', 'health.read')
  @ApiOperation({ summary: 'Health summary and the last 30 days of health events for the client’s deployments.' })
  health(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<ClientHealthDto> {
    return this.clients.health(auth, id);
  }

  @Get(':id/activity')
  @RequirePermissions('clients.read')
  @ApiOperation({ summary: 'Audit events recorded against this client.' })
  activity(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Query(new ZodPipe(activityQuery)) q: z.infer<typeof activityQuery>,
  ): Promise<Paged<AuditEventDto>> {
    return this.clients.activity(auth, id, q.page, q.pageSize);
  }
}

@ApiTags('catalog')
@ApiCookieAuth('session')
@Controller()
export class CatalogController {
  constructor(@Inject(ClientsService) private readonly clients: ClientsService) {}

  @Get('directory/users')
  @RequirePermissions('clients.read')
  @ApiOperation({ summary: 'Active users of the organization (for account manager / technical owner selection).' })
  users(@CurrentAuth() auth: AuthContext): Promise<UserRef[]> {
    return this.clients.userDirectory(auth);
  }

}
