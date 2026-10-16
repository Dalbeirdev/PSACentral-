import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type pg from 'pg';
import { JsonLogger } from './common/logger.js';
import { ProblemFilter } from './common/problem.filter.js';
import { APP_CONFIG, type AppConfig } from './config/env.js';
import { defaultRateLimit } from './config/rate-limits.js';
import { createPool, DatabaseService, PG_POOL } from './database/database.service.js';
import { AuditController } from './modules/audit/audit.controller.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AppThrottlerGuard, CsrfGuard, PermissionsGuard, SessionGuard } from './modules/auth/guards.js';
import { SessionService } from './modules/auth/session.service.js';
import { DashboardController } from './modules/dashboard/dashboard.controller.js';
import { DatabaseExplorerController } from './modules/database-explorer/database-explorer.controller.js';
import { DatabaseExplorerService } from './modules/database-explorer/database-explorer.service.js';
import { DashboardService } from './modules/dashboard/dashboard.service.js';
import { DeploymentsController } from './modules/deployments/deployments.controller.js';
import { DeploymentsService } from './modules/deployments/deployments.service.js';
import { CommandsController } from './modules/deployments/commands.controller.js';
import { CommandsService } from './modules/deployments/commands.service.js';
import { LicensesController } from './modules/deployments/licenses.controller.js';
import { LicensesService } from './modules/deployments/licenses.service.js';
import { LicensingKeyController, RetentionController } from './modules/deployments/retention.controller.js';
import { RetentionService } from './modules/deployments/retention.service.js';
import { LicenseTokensService } from './modules/deployments/license-tokens.service.js';
import { AgentGateway } from './modules/agents/agent-gateway.js';
import { ClientDeletionService } from './modules/agents/client-deletion.service.js';
import { HealthController } from './modules/health/health.controller.js';
import { HealthService } from './modules/health/health.service.js';
import { PkiService } from './modules/agents/pki.service.js';
import { SystemController } from './modules/system/system.controller.js';
import { CatalogController, ClientsController } from './modules/clients/clients.controller.js';
import { ClientsService } from './modules/clients/clients.service.js';
import { ServicesController } from './modules/services/services.controller.js';
import { ServicesService } from './modules/services/services.service.js';
import { OnboardingController } from './modules/onboarding/onboarding.controller.js';
import { PsaAdapterRegistry, psaAdapterProviders } from './modules/psa/adapters/registry.js';
import { PsaController } from './modules/psa/psa.controller.js';
import { PsaService } from './modules/psa/psa.service.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
import { RolesController, UserAssignmentsController, UsersController } from './modules/users/users.controller.js';
import { UsersService } from './modules/users/users.service.js';

export const CONTROLLERS = [
  AuthController,
  UsersController,
  UserAssignmentsController,
  RolesController,
  ClientsController,
  ServicesController,
  CatalogController,
  OnboardingController,
  PsaController,
  DeploymentsController,
  CommandsController,
  LicensesController,
  RetentionController,
  LicensingKeyController,
  HealthController,
  DatabaseExplorerController,
  AuditController,
  DashboardController,
  SystemController,
];

@Module({})
export class AppModule {
  static register(config: AppConfig, logger: JsonLogger, pool?: pg.Pool): DynamicModule {
    return {
      module: AppModule,
      imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ...defaultRateLimit }] })],
      controllers: CONTROLLERS,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: JsonLogger, useValue: logger },
        { provide: PG_POOL, useValue: pool ?? createPool(config, logger) },
        DatabaseService,
        AuditService,
        SessionService,
        AuthService,
        UsersService,
        DashboardService,
        ClientsService,
        ServicesService,
        ...psaAdapterProviders,
        PsaAdapterRegistry,
        PsaService,
        PkiService,
        HealthService,
        DatabaseExplorerService,
        AgentGateway,
        ClientDeletionService,
        DeploymentsService,
        CommandsService,
        LicensesService,
        RetentionService,
        LicenseTokensService,
        OnboardingService,
        // Guard order matters: rate limit → session → CSRF → permissions (default deny).
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_FILTER, useFactory: (l: JsonLogger) => new ProblemFilter(l), inject: [JsonLogger] },
      ],
    };
  }
}
