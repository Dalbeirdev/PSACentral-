import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type CommandIssue, commandIssueSchema, commandListQuerySchema, type RemoteCommandDto, type RemoteOperationsDto } from '@psacc/contracts';
import type { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { CommandsService } from './commands.service.js';

const uuid = new ParseUUIDPipe();

/** Remote operations on a deployment (Module 13): signed commands pulled by the appliance's agent. */
@ApiTags('deployments')
@ApiCookieAuth('session')
@Controller('deployments')
export class CommandsController {
  constructor(@Inject(CommandsService) private readonly commands: CommandsService) {}

  @Get(':id/operations')
  @RequirePermissions('deployments.read')
  @ApiOperation({ summary: 'Remote operations: whether commands can be issued, the upgrade target, open commands and the history.' })
  @ApiZodQuery(commandListQuerySchema)
  operations(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Query(new ZodPipe(commandListQuerySchema)) q: z.infer<typeof commandListQuerySchema>): Promise<RemoteOperationsDto> {
    return this.commands.operations(auth, id, q.status, q.limit);
  }

  @Post(':id/commands')
  @RequirePermissions('deployments.commands.issue')
  @HttpCode(201)
  @ApiOperation({ summary: 'Issue a signed remote command. The agent fetches it with its next heartbeat and verifies the signature before executing it.' })
  @ApiZodBody(commandIssueSchema)
  issue(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Body(new ZodPipe(commandIssueSchema)) dto: CommandIssue, @CurrentRequest() req: AppRequest): Promise<RemoteCommandDto> {
    return this.commands.issue(auth, id, dto, requestMeta(req));
  }

  @Post(':id/commands/:commandId/cancel')
  @RequirePermissions('deployments.commands.issue')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a command the agent has not fetched yet.' })
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string, @Param('commandId', uuid) commandId: string, @CurrentRequest() req: AppRequest): Promise<RemoteCommandDto> {
    return this.commands.cancel(auth, id, commandId, requestMeta(req));
  }
}
