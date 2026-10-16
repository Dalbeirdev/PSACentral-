import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { DashboardSummary, NotificationsResponse, SearchResponse } from '@psacc/contracts';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth-context.js';
import { AuthenticatedOnly, CurrentAuth, RequirePermissions } from '../../common/decorators.js';
import { ZodPipe } from '../../common/zod.js';
import { DashboardService } from './dashboard.service.js';

const searchQuery = z.strictObject({ q: z.string().max(200).default('') });

@ApiTags('dashboard')
@ApiCookieAuth('session')
@Controller()
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @Get('dashboard/summary')
  @RequirePermissions('dashboard.read')
  @ApiOperation({ summary: 'KPIs, chart series and recent deployments, scoped to the caller. Includes data provenance.' })
  summary(@CurrentAuth() auth: AuthContext): Promise<DashboardSummary> {
    return this.dashboard.summary(auth);
  }

  @Get('search')
  @AuthenticatedOnly()
  @ApiOperation({ summary: 'Global search across clients, deployments and PSA instances the caller may read.' })
  @ApiQuery({ name: 'q', required: true })
  search(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(searchQuery)) query: z.infer<typeof searchQuery>): Promise<SearchResponse> {
    return this.dashboard.search(auth, query.q);
  }

  @Get('notifications')
  @AuthenticatedOnly()
  @ApiOperation({ summary: 'Operational notifications: deployment health problems and own-account security notices.' })
  notifications(@CurrentAuth() auth: AuthContext): Promise<NotificationsResponse> {
    return this.dashboard.notifications(auth);
  }
}
