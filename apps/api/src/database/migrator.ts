import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { syncReferenceData } from './reference-data.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_KEY = 4_210_001; // pg_advisory_lock key for this application's migrations

export interface MigrationFile {
  version: string;
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  appliedAt: Date | null;
  state: 'applied' | 'pending' | 'checksum_mismatch';
}

export function loadMigrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      // Normalize line endings so checksums are identical on Windows and Linux checkouts.
      const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/\r\n/g, '\n');
      const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
      return {
        version: version!,
        name: rest.join('_'),
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    });
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version       text PRIMARY KEY,
    name          text NOT NULL,
    checksum      text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at    timestamptz NOT NULL DEFAULT now(),
    applied_by    text NOT NULL DEFAULT current_user,
    execution_ms  integer NOT NULL
  );
  GRANT SELECT ON schema_migrations TO psacc_app_rw;`;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock.
 * Refuses to run if an applied migration file was modified (checksum mismatch).
 * Idempotent: running it again applies nothing and only re-syncs reference data.
 */
export async function migrate(connectionString: string, log: (m: string) => void = console.log): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString, application_name: 'psacc-migrator' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(CREATE_TABLE);
    const files = loadMigrationFiles();
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const f of files) {
      const existing = applied.get(f.version);
      if (existing && existing !== f.checksum) {
        throw new Error(`Migration ${f.version}_${f.name} was modified after being applied (checksum mismatch). Create a new migration instead.`);
      }
    }

    const result: MigrateResult = { applied: [], alreadyApplied: applied.size };
    for (const f of files) {
      if (applied.has(f.version)) continue;
      const started = performance.now();
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)', [
          f.version,
          f.name,
          f.checksum,
          Math.round(performance.now() - started),
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f.version}_${f.name} failed: ${(err as Error).message}`);
      }
      log(`applied ${f.version}_${f.name}`);
      result.applied.push(`${f.version}_${f.name}`);
    }

    await client.query('BEGIN');
    try {
      await syncReferenceData(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

export async function migrationStatus(q: { query: (sql: string) => Promise<{ rows: unknown[] }> } | pg.Client | pg.Pool): Promise<MigrationStatus[]> {
  const files = loadMigrationFiles();
  let rows: { version: string; checksum: string; applied_at: Date }[] = [];
  try {
    rows = (await (q as pg.Pool).query('SELECT version, checksum, applied_at FROM schema_migrations')).rows;
  } catch {
    rows = [];
  }
  const applied = new Map(rows.map((r) => [r.version, r]));
  return files.map((f) => {
    const a = applied.get(f.version);
    return {
      version: f.version,
      name: f.name,
      appliedAt: a?.applied_at ?? null,
      state: !a ? 'pending' : a.checksum === f.checksum ? 'applied' : 'checksum_mismatch',
    };
  });
}
