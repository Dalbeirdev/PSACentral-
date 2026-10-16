import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type AuditEventDto, auditQuerySchema, type Paged } from '@psacc/contracts';
import type { z } from 'zod';
import type { AuthContext } from '../../common/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../../common/decorators.js';
import { ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { AuditService } from './audit.service.js';

@ApiTags('audit')
@ApiCookieAuth('session')
@Controller('audit-events')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'Search the append-only audit trail (server-side filter, sort, pagination).' })
  @ApiZodQuery(auditQuerySchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(auditQuerySchema)) query: z.infer<typeof auditQuerySchema>,
  ): Promise<Paged<AuditEventDto>> {
    return this.audit.list(auth, query);
  }
}
