import { describe, expect, it } from 'vitest';
import { databaseReportSchema, databaseSchemaReportSchema, EDGE_REPORT_TYPES, REPORT_SCHEMAS } from './index.js';

const at = '2026-10-14T10:00:00.000Z';
const table = {
  schema: 'public', name: 'helpdesk_tickets', kind: 'table',
  columns: [
    { position: 1, name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()', identity: false },
    { position: 2, name: 'subject', type: 'text', nullable: false, default: null, identity: false },
  ],
  primaryKey: { name: 'helpdesk_tickets_pkey', columns: ['id'] },
  indexes: [{ name: 'helpdesk_tickets_pkey', unique: true, primary: true, definition: 'CREATE UNIQUE INDEX helpdesk_tickets_pkey ON public.helpdesk_tickets USING btree (id)', sizeBytes: 8192 }],
  foreignKeys: [{ name: 'helpdesk_tickets_psa_fk', columns: ['psa_connection_id'], referencedSchema: 'public', referencedTable: 'psa_connections', referencedColumns: ['id'], onDelete: 'restrict' }],
  stats: { estimatedRows: 0, liveRows: 0, deadRows: 0, lastAnalyzeAt: null, lastAutoanalyzeAt: at, lastVacuumAt: null, lastAutovacuumAt: null, totalBytes: 40960, tableBytes: 8192, indexBytes: 32768, toastBytes: 0 },
};

describe('database_schema report', () => {
  it('accepts a part of a snapshot with columns, keys, indexes and statistics', () => {
    const r = databaseSchemaReportSchema.safeParse({ fingerprint: 'a'.repeat(32), part: 1, parts: 2, tables: [table] });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(REPORT_SCHEMAS.database_schema).toBe(databaseSchemaReportSchema);
    expect(EDGE_REPORT_TYPES).toContain('database_schema');
  });

  it('is strict: nothing but catalog metadata can be carried', () => {
    const base = { fingerprint: 'a'.repeat(32), part: 1, parts: 1 };
    expect(databaseSchemaReportSchema.safeParse({ ...base, tables: [{ ...table, rows: [{ id: 1 }] }] }).success).toBe(false);
    expect(databaseSchemaReportSchema.safeParse({ ...base, tables: [{ ...table, sample: 'x' }] }).success).toBe(false);
    expect(databaseSchemaReportSchema.safeParse({ ...base, tables: [table], records: [] }).success).toBe(false);
    expect(databaseSchemaReportSchema.safeParse({ ...base, tables: [{ ...table, columns: [{ ...table.columns[0], value: 'x' }] }] }).success).toBe(false);
    // Definitions and defaults are bounded printable ASCII (DDL), never arbitrary content.
    expect(databaseSchemaReportSchema.safeParse({ ...base, tables: [{ ...table, indexes: [{ ...table.indexes[0], definition: 'x'.repeat(501) }] }] }).success).toBe(false);
    expect(databaseSchemaReportSchema.safeParse({ ...base, tables: [{ ...table, columns: [{ ...table.columns[0], default: 'ünicode' }] }] }).success).toBe(false);
    expect(databaseSchemaReportSchema.safeParse({ ...base, part: 3, parts: 2, tables: [table] }).success).toBe(false);
    expect(databaseSchemaReportSchema.safeParse({ ...base, fingerprint: 'not-hex', tables: [table] }).success).toBe(false);
    expect(databaseSchemaReportSchema.safeParse({ ...base, tables: Array.from({ length: 51 }, () => table) }).success).toBe(false);
  });

  it('the database report may name the database and keeps estimated rows nullable', () => {
    const r = databaseReportSchema.safeParse({ available: true, databaseName: 'psa_edge', serverVersion: '17.6', schemaVersion: '0002', migrationsApplied: 2, sizeBytes: 1, tables: [{ schema: 'public', name: 't', estimatedRows: null, sizeBytes: 0, columns: 1, hasPrimaryKey: false, indexes: 0, foreignKeys: 0 }] });
    expect(r.success).toBe(true);
    expect(databaseReportSchema.safeParse({ available: true, migrationsApplied: 0, sizeBytes: 0, tables: [], rows: [] }).success).toBe(false);
  });
});
