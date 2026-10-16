import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  clientAssignmentsSchema,
  type CreateUserResponse,
  createUserSchema,
  type Paged,
  PERMISSIONS,
  type RoleSummary,
  updateUserSchema,
  type UserDetail,
  userListQuerySchema,
  type UserSummary,
} from '@psacc/contracts';
import type { z } from 'zod';
import { type AppRequest, type AuthContext, requestMeta } from '../../common/auth-context.js';
import { CurrentAuth, CurrentRequest, RequirePermissions } from '../../common/decorators.js';
import { ApiZodBody, ApiZodQuery, ZodPipe } from '../../common/zod.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiCookieAuth('session')
@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'List users (server-side search, filter, sort, pagination).' })
  @ApiZodQuery(userListQuerySchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(userListQuerySchema)) query: z.infer<typeof userListQuerySchema>,
  ): Promise<Paged<UserSummary>> {
    return this.users.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('users.read')
  @ApiOperation({ summary: 'User detail with roles, scope and client assignments.' })
  get(@CurrentAuth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<UserDetail> {
    return this.users.get(auth, id);
  }

  @Post()
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Create a user. A temporary password is generated and returned once if none is supplied.' })
  @ApiZodBody(createUserSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createUserSchema)) dto: z.infer<typeof createUserSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<CreateUserResponse> {
    return this.users.create(auth, dto, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Update display name, status or roles.' })
  @ApiZodBody(updateUserSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateUserSchema)) dto: z.infer<typeof updateUserSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<UserDetail> {
    return this.users.update(auth, id, dto, requestMeta(req));
  }
}

@ApiTags('users')
@ApiCookieAuth('session')
@Controller('users')
export class UserAssignmentsController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Put(':id/client-assignments')
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Replace the clients a scoped user (e.g. Technician) can access.' })
  @ApiZodBody(clientAssignmentsSchema)
  set(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(clientAssignmentsSchema)) dto: z.infer<typeof clientAssignmentsSchema>,
    @CurrentRequest() req: AppRequest,
  ): Promise<UserDetail> {
    return this.users.setClientAssignments(auth, id, dto.clientIds, requestMeta(req));
  }
}

@ApiTags('rbac')
@ApiCookieAuth('session')
@Controller()
export class RolesController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get('roles')
  @RequirePermissions('roles.read')
  @ApiOperation({ summary: 'Roles with their permissions and user counts.' })
  roles(@CurrentAuth() auth: AuthContext): Promise<RoleSummary[]> {
    return this.users.roles(auth);
  }

  @Get('permissions')
  @RequirePermissions('roles.read')
  @ApiOperation({ summary: 'Permission catalog.' })
  permissions() {
    return Object.entries(PERMISSIONS).map(([key, v]) => ({ key, ...v }));
  }
}
