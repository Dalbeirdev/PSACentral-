import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { SystemInfo } from '@psacc/contracts';
import type { Response } from 'express';
import type pg from 'pg';
import { Public, RequirePermissions } from '../../common/decorators.js';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { DatabaseService, PG_POOL } from '../../database/database.service.js';
import { migrationStatus } from '../../database/migrator.js';

@ApiTags('system')
@Controller()
export class SystemController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  @Get('health/live')
  @Public()
  @SkipThrottle()
  @ApiOperation({ summary: 'Liveness: the process is running.' })
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  @SkipThrottle()
  @HttpCode(200)
  @ApiOperation({ summary: 'Readiness: database reachable and no pending migrations. 503 otherwise.' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const db = await this.db.ping();
    const migrations = db.ok ? await migrationStatus(this.pool) : [];
    const pending = migrations.filter((m) => m.state !== 'applied').length;
    const ok = db.ok && pending === 0;
    if (!ok) res.status(503);
    return {
      status: ok ? 'ready' : 'not_ready',
      checks: {
        database: { status: db.ok ? 'up' : 'down', latencyMs: db.latencyMs },
        migrations: { status: pending === 0 && db.ok ? 'current' : 'pending', pending },
      },
    };
  }

  @Get('system/info')
  @Public()
  @ApiOperation({ summary: 'Public, non-sensitive environment info used by the UI environment badge.' })
  info(): SystemInfo {
    return { name: 'PSA Control Center', environment: this.config.env, version: this.config.version, mfaRequired: this.config.auth.mfaRequired };
  }

  @Get('system/status')
  @RequirePermissions('settings.read')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Control plane status: database server, schema migrations, security policy.' })
  async status() {
    const db = await this.db.ping();
    const server = db.ok
      ? (await this.pool.query<{ version: string; db: string; size: string }>(
          `SELECT current_setting('server_version') AS version, current_database() AS db,
                  pg_size_pretty(pg_database_size(current_database())) AS size`,
        )).rows[0]
      : undefined;
    return {
      environment: this.config.env,
      version: this.config.version,
      database: { status: db.ok ? 'up' : 'down', latencyMs: db.latencyMs, serverVersion: server?.version ?? null, name: server?.db ?? null, size: server?.size ?? null },
      migrations: db.ok ? await migrationStatus(this.pool) : [],
      security: {
        mfaRequired: this.config.auth.mfaRequired,
        sessionIdleMinutes: this.config.auth.sessionIdleMinutes,
        sessionAbsoluteHours: this.config.auth.sessionAbsoluteHours,
        secureCookies: this.config.auth.secureCookies,
        loginMaxFailures: this.config.auth.loginMaxFailures,
        loginLockMinutes: this.config.auth.loginLockMinutes,
      },
    };
  }
}
