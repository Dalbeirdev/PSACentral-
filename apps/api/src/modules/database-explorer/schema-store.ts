import type { ReportPayload } from '@psacc/contracts';
import type { Queryable } from '../../database/database.service.js';

/**
 * Projects one part of a `database_schema` report into deployment_tables (one row per table). Parts
 * of a snapshot share a fingerprint; when the last part arrives, tables that are no longer in the
 * snapshot are removed. Older parts never overwrite newer rows. Nothing but catalog metadata is stored.
 */
export async function storeSchemaPart(
  q: Queryable,
  ctx: { orgId: string; clientId: string; deploymentId: string },
  p: ReportPayload<'database_schema'>,
  observedAt: string,
): Promise<void> {
  for (const t of p.tables) {
    await q.query(
      `INSERT INTO deployment_tables (organization_id, client_id, deployment_id, schema_name, table_name, kind, fingerprint, observed_at, received_at, columns, primary_key, indexes, foreign_keys, stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), $9, $10, $11, $12, $13)
       ON CONFLICT (deployment_id, schema_name, table_name) DO UPDATE SET
         kind = EXCLUDED.kind, fingerprint = EXCLUDED.fingerprint, observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at,
         columns = EXCLUDED.columns, primary_key = EXCLUDED.primary_key, indexes = EXCLUDED.indexes, foreign_keys = EXCLUDED.foreign_keys, stats = EXCLUDED.stats
       WHERE deployment_tables.observed_at <= EXCLUDED.observed_at`,
      [ctx.orgId, ctx.clientId, ctx.deploymentId, t.schema, t.name, t.kind, p.fingerprint, observedAt,
        JSON.stringify(t.columns), t.primaryKey ? JSON.stringify(t.primaryKey) : null, JSON.stringify(t.indexes), JSON.stringify(t.foreignKeys), JSON.stringify(t.stats)],
    );
  }
  if (p.part === p.parts) {
    await q.query('DELETE FROM deployment_tables WHERE deployment_id = $1 AND fingerprint <> $2 AND observed_at <= $3', [ctx.deploymentId, p.fingerprint, observedAt]);
  }
}
