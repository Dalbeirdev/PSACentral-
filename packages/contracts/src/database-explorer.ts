import { z } from 'zod';
import type { HealthState } from './common.js';
import type { TableSchema } from './health.js';

/**
 * Database Explorer (Module 9): metadata about each appliance database as reported by the agent's
 * catalog-only inspector role. Table rows never exist on the Control Plane, so nothing here can show
 * them.
 */

export interface DatabaseSummary {
  databaseName: string | null;
  available: boolean;
  serverVersion: string | null;
  schemaVersion: string | null;
  migrationsApplied: number;
  lastMigratedAt: string | null;
  sizeBytes: number;
  tableCount: number;
  /** The agent's inspection error code, if the last inventory failed. */
  error: string | null;
  observedAt: string;
  receivedAt: string;
}

export interface DatabaseExplorerRow {
  id: string;
  code: string;
  client: { id: string; code: string; displayName: string };
  isSynthetic: boolean;
  lifecycleState: string;
  healthState: HealthState;
  /** Null until the agent's first database report. */
  database: DatabaseSummary | null;
  /** Tables with schema details (columns, keys, indexes) on file. */
  detailedTables: number;
  lastSchemaAt: string | null;
}

export interface DatabaseExplorerDto {
  generatedAt: string;
  summary: { live: number; synthetic: number; available: number; unavailable: number; awaiting: number };
  rows: DatabaseExplorerRow[];
}

export const databaseExplorerQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  live: z.enum(['1']).optional(),
  availability: z.enum(['available', 'unavailable', 'awaiting']).optional(),
});

export interface TableInventoryRow {
  schema: string;
  name: string;
  /** PostgreSQL's planner estimate (pg_class.reltuples); null until analysed. Never an exact count. */
  estimatedRows: number | null;
  sizeBytes: number;
  columns: number;
  hasPrimaryKey: boolean;
  indexes: number;
  foreignKeys: number;
  kind: 'table' | 'partitioned' | null;
  /** When the schema details for this table were observed; null while they are pending. */
  detailsObservedAt: string | null;
}

export interface DeploymentDatabaseDto {
  deploymentId: string;
  code: string;
  client: { id: string; code: string; displayName: string };
  isSynthetic: boolean;
  lifecycleState: string;
  healthState: HealthState;
  database: DatabaseSummary | null;
  tables: TableInventoryRow[];
  inspection: {
    lastInventoryAt: string | null;
    lastSchemaAt: string | null;
    fingerprint: string | null;
    detailedTables: number;
    pendingTables: number;
  };
  /** Inspection errors reported in the last 7 days, grouped by code. */
  errors: { code: string; count: number; firstSeenAt: string; lastSeenAt: string }[];
}

export interface TableDetailDto extends TableSchema {
  deploymentId: string;
  code: string;
  client: { id: string; code: string; displayName: string };
  observedAt: string;
  receivedAt: string;
  fingerprint: string;
  /** The inventory row for the same table from the latest database report, if present. */
  inventory: Omit<TableInventoryRow, 'kind' | 'detailsObservedAt'> | null;
}
