import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import type { AuthContext, TenantContext } from '../common/auth-context.js';
import type { JsonLogger } from '../common/logger.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

// Return int8/numeric as JS numbers where safe (counts, sizes); timestamps stay Date objects.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});
// DATE has no time zone: keep it as 'YYYY-MM-DD' instead of a local-midnight Date (which shifts days).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
}

function wrap(client: pg.PoolClient | pg.Pool): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params as unknown[]);
      return r.rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params as unknown[]);
      if (r.rows.length !== 1) throw new Error(`Expected exactly one row, got ${r.rows.length}`);
      return r.rows[0] as T;
    },
    async maybeOne<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params as unknown[]);
      if (r.rows.length > 1) throw new Error(`Expected at most one row, got ${r.rows.length}`);
      return (r.rows[0] as T | undefined) ?? null;
    },
  };
}

export const PG_POOL = Symbol('PG_POOL');

export function createPool(config: AppConfig, logger?: Pick<JsonLogger, 'warn'>): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    application_name: 'psacc-api',
    statement_timeout: config.database.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.database.statementTimeoutMs * 2,
    connectionTimeoutMillis: 5_000,
  });
  // An idle pooled connection that the server closes (PostgreSQL restart, failover, `pg_terminate_backend`)
  // is reported as an 'error' event on the pool. Without a listener Node treats it as unhandled and the
  // whole API process exits; with one the connection is simply discarded and replaced on the next checkout.
  pool.on('error', (err) => {
    (logger ?? console).warn({ msg: 'A pooled database connection was closed by the server and will be replaced', error: err.message }, 'DatabaseService');
  });
  return pool;
}

/**
 * All application data access goes through `tenant()`: one transaction per unit of work,
 * with transaction-local settings that PostgreSQL row-level security policies read.
 * Settings are cleared at COMMIT/ROLLBACK, so pooled connections never leak context.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async tenant<T>(ctx: AuthContext | TenantContext, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.scope_all', $3, true)`,
        [ctx.orgId, ctx.userId ?? '', ctx.scopeAll ? 'on' : 'off'],
      );
      const result = await fn(wrap(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** No tenant context: only for SECURITY DEFINER auth functions and health checks. */
  async unscoped<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return fn(wrap(this.pool));
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = performance.now();
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, latencyMs: Math.round(performance.now() - started), error: (err as Error).message };
    }
  }

  get environment() {
    return this.config.env;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
