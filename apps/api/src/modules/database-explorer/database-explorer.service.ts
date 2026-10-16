import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseExplorerDto, DatabaseExplorerRow, DatabaseSummary, DeploymentDatabaseDto, HealthState, ReportPayload, TableDetailDto, TableInventoryRow } from '@psacc/contracts';
import type { AuthContext } from '../../common/auth-context.js';
import { AppError } from '../../common/problem.filter.js';
import { DatabaseService, type Queryable } from '../../database/database.service.js';
import { escapeLike } from '../audit/audit.service.js';

type Row = Record<string, unknown>;
type DatabaseReport = ReportPayload<'database'>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : null);

function summaryOf(payload: DatabaseReport | null, observedAt: unknown, receivedAt: unknown): DatabaseSummary | null {
  if (!payload) return null;
  return {
    databaseName: payload.databaseName ?? null,
    available: payload.available,
    serverVersion: payload.serverVersion ?? null,
    schemaVersion: payload.schemaVersion ?? null,
    migrationsApplied: payload.migrationsApplied,
    lastMigratedAt: payload.lastMigratedAt ?? null,
    sizeBytes: payload.sizeBytes,
    tableCount: payload.tables.length,
    error: payload.error ?? null,
    observedAt: iso(observedAt)!,
    receivedAt: iso(receivedAt)!,
  };
}

/**
 * Database Explorer: the appliance database metadata the agent reported (inventory from the
 * `database` report, per-table schema from `database_schema` parts). Read-only; there is no path
 * from here to any table row because none is ever sent.
 */
@Injectable()
export class DatabaseExplorerService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async fleet(auth: AuthContext, query: { q?: string; live?: '1'; availability?: 'available' | 'unavailable' | 'awaiting' }): Promise<DatabaseExplorerDto> {
    return this.db.tenant(auth, async (q) => {
      const where: string[] = [`d.lifecycle_state <> 'decommissioned'`];
      const params: unknown[] = [];
      if (query.q) { params.push(`%${escapeLike(query.q)}%`); where.push(`(d.code ILIKE $${params.length} OR c.display_name ILIKE $${params.length} OR c.code ILIKE $${params.length})`); }
      if (query.live) where.push('NOT d.is_synthetic');
      if (query.availability === 'available') where.push(`db.payload->>'available' = 'true'`);
      if (query.availability === 'unavailable') where.push(`db.payload->>'available' = 'false'`);
      if (query.availability === 'awaiting') where.push('db.deployment_id IS NULL AND NOT d.is_synthetic');
      const rows = await q.query<Row>(
        `SELECT d.id, d.code, d.client_id, c.code AS client_code, c.display_name AS client_name, d.is_synthetic, d.lifecycle_state, d.health_state,
                db.payload AS database, db.observed_at AS db_observed_at, db.received_at AS db_received_at,
                (SELECT count(*)::int FROM deployment_tables t WHERE t.deployment_id = d.id) AS detailed_tables,
                (SELECT max(t.observed_at) FROM deployment_tables t WHERE t.deployment_id = d.id) AS last_schema_at
         FROM deployments d JOIN clients c ON c.id = d.client_id
         LEFT JOIN deployment_report_latest db ON db.deployment_id = d.id AND db.report_type = 'database'
         WHERE ${where.join(' AND ')}
         ORDER BY d.is_synthetic, (db.payload->>'available') DESC NULLS LAST, c.display_name, d.code`,
        params,
      );
      const summary = { live: 0, synthetic: 0, available: 0, unavailable: 0, awaiting: 0 };
      const out: DatabaseExplorerRow[] = rows.map((r) => {
        const database = summaryOf(r.database as DatabaseReport | null, r.db_observed_at, r.db_received_at);
        if (r.is_synthetic) summary.synthetic++;
        else {
          summary.live++;
          if (!database) summary.awaiting++;
          else if (database.available) summary.available++;
          else summary.unavailable++;
        }
        return {
          id: r.id as string, code: r.code as string, client: { id: r.client_id as string, code: r.client_code as string, displayName: r.client_name as string },
          isSynthetic: r.is_synthetic as boolean, lifecycleState: r.lifecycle_state as string, healthState: r.health_state as HealthState,
          database, detailedTables: r.detailed_tables as number, lastSchemaAt: iso(r.last_schema_at),
        };
      });
      return { generatedAt: new Date().toISOString(), summary, rows: out };
    });
  }

  private async deploymentRow(q: Queryable, id: string) {
    const d = await q.maybeOne<Row>(
      `SELECT d.id, d.code, d.client_id, d.is_synthetic, d.lifecycle_state, d.health_state, c.code AS client_code, c.display_name AS client_name,
              db.payload AS database, db.observed_at AS db_observed_at, db.received_at AS db_received_at
       FROM deployments d JOIN clients c ON c.id = d.client_id
       LEFT JOIN deployment_report_latest db ON db.deployment_id = d.id AND db.report_type = 'database'
       WHERE d.id = $1`,
      [id],
    );
    if (!d) throw new AppError(404, 'not-found', 'Deployment not found.');
    return d;
  }

  async deployment(auth: AuthContext, id: string): Promise<DeploymentDatabaseDto> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.deploymentRow(q, id);
      const payload = d.database as DatabaseReport | null;
      const details = await q.query<Row>('SELECT schema_name, table_name, kind, fingerprint, observed_at, stats FROM deployment_tables WHERE deployment_id = $1 ORDER BY observed_at DESC', [id]);
      const byName = new Map(details.map((t) => [`${t.schema_name}.${t.table_name}`, t]));
      const inventory = payload?.tables ?? [];
      const tables: TableInventoryRow[] = inventory.map((t) => {
        const det = byName.get(`${t.schema}.${t.name}`);
        return { ...t, kind: (det?.kind as 'table' | 'partitioned' | undefined) ?? null, detailsObservedAt: det ? iso(det.observed_at) : null };
      });
      // Tables with details but missing from the latest inventory (e.g. the inventory failed): shown from the detail statistics.
      for (const det of details) {
        if (inventory.some((t) => t.schema === det.schema_name && t.name === det.table_name)) continue;
        const s = det.stats as ReportPayload<'database_schema'>['tables'][number]['stats'];
        const full = await q.one<Row>('SELECT columns, primary_key, indexes, foreign_keys FROM deployment_tables WHERE deployment_id = $1 AND schema_name = $2 AND table_name = $3', [id, det.schema_name, det.table_name]);
        tables.push({
          schema: det.schema_name as string, name: det.table_name as string, estimatedRows: s.estimatedRows, sizeBytes: s.totalBytes,
          columns: (full.columns as unknown[]).length, hasPrimaryKey: full.primary_key !== null, indexes: (full.indexes as unknown[]).length, foreignKeys: (full.foreign_keys as unknown[]).length,
          kind: det.kind as 'table' | 'partitioned', detailsObservedAt: iso(det.observed_at),
        });
      }
      tables.sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));
      const errors = await q.query<Row>(
        `SELECT payload->>'error' AS code, count(*)::int AS count, min(observed_at) AS first_seen_at, max(observed_at) AS last_seen_at
         FROM deployment_reports WHERE deployment_id = $1 AND report_type = 'database' AND payload ? 'error' AND observed_at > now() - interval '7 days'
         GROUP BY 1 ORDER BY 4 DESC`,
        [id],
      );
      const newest = details[0];
      return {
        deploymentId: id, code: d.code as string, client: { id: d.client_id as string, code: d.client_code as string, displayName: d.client_name as string },
        isSynthetic: d.is_synthetic as boolean, lifecycleState: d.lifecycle_state as string, healthState: d.health_state as HealthState,
        database: summaryOf(payload, d.db_observed_at, d.db_received_at),
        tables,
        inspection: {
          lastInventoryAt: iso(d.db_observed_at),
          lastSchemaAt: newest ? iso(newest.observed_at) : null,
          fingerprint: newest ? (newest.fingerprint as string) : null,
          detailedTables: tables.filter((t) => t.detailsObservedAt).length,
          pendingTables: tables.filter((t) => !t.detailsObservedAt).length,
        },
        errors: errors.map((e) => ({ code: e.code as string, count: e.count as number, firstSeenAt: iso(e.first_seen_at)!, lastSeenAt: iso(e.last_seen_at)! })),
      };
    });
  }

  async table(auth: AuthContext, id: string, schema: string, name: string): Promise<TableDetailDto> {
    return this.db.tenant(auth, async (q) => {
      const d = await this.deploymentRow(q, id);
      const t = await q.maybeOne<Row>('SELECT * FROM deployment_tables WHERE deployment_id = $1 AND schema_name = $2 AND table_name = $3', [id, schema, name]);
      if (!t) throw new AppError(404, 'not-found', 'No schema details for this table have been reported.');
      const inv = (d.database as DatabaseReport | null)?.tables.find((x) => x.schema === schema && x.name === name) ?? null;
      return {
        deploymentId: id, code: d.code as string, client: { id: d.client_id as string, code: d.client_code as string, displayName: d.client_name as string },
        schema, name, kind: t.kind as 'table' | 'partitioned', observedAt: iso(t.observed_at)!, receivedAt: iso(t.received_at)!, fingerprint: t.fingerprint as string,
        columns: t.columns as TableDetailDto['columns'], primaryKey: t.primary_key as TableDetailDto['primaryKey'], indexes: t.indexes as TableDetailDto['indexes'],
        foreignKeys: t.foreign_keys as TableDetailDto['foreignKeys'], stats: t.stats as TableDetailDto['stats'],
        inventory: inv,
      };
    });
  }
}
