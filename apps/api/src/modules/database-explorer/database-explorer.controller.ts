import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type DatabaseExplorerDto, databaseExplorerQuerySchema, type DeploymentDatabaseDto, type TableDetailDto } from '@psacc/contracts';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../../common/decorators.js';
import { ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { DatabaseExplorerService } from './database-explorer.service.js';

const uuid = new ParseUUIDPipe();
const ident = new ZodPipe(z.string().min(1).max(64));

/** Read-only metadata views. There is no endpoint that could return a table row, a query result or run SQL. */
@ApiTags('database-explorer')
@ApiCookieAuth('session')
@Controller()
export class DatabaseExplorerController {
  constructor(@Inject(DatabaseExplorerService) private readonly explorer: DatabaseExplorerService) {}

  @Get('database-explorer')
  @RequirePermissions('database.metadata.read')
  @ApiOperation({ summary: 'Every deployment with the database metadata its agent reported (availability, version, size, table count).' })
  @ApiZodQuery(databaseExplorerQuerySchema)
  fleet(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(databaseExplorerQuerySchema)) q: z.infer<typeof databaseExplorerQuerySchema>): Promise<DatabaseExplorerDto> {
    return this.explorer.fleet(auth, q);
  }

  @Get('deployments/:id/database')
  @RequirePermissions('database.metadata.read')
  @ApiOperation({ summary: 'A deployment’s database: summary, table inventory with planner estimates, inspection state and errors.' })
  deployment(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<DeploymentDatabaseDto> {
    return this.explorer.deployment(auth, id);
  }

  @Get('deployments/:id/database/tables/:schema/:table')
  @RequirePermissions('database.metadata.read')
  @ApiOperation({ summary: 'One table’s schema metadata: columns, primary key, indexes, foreign keys and row-count statistics.' })
  table(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Param('schema', ident) schema: string, @Param('table', ident) table: string): Promise<TableDetailDto> {
    return this.explorer.table(auth, id, schema, table);
  }
}
