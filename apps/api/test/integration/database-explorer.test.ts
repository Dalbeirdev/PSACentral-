import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentGateway } from '../../src/modules/agents/agent-gateway.js';
import { type AgentIdentity, enrolledAgent, gw, healthyReports, schemaPart, tableSchema } from './agent-helpers.js';
import { type Client, EMAIL, asApp, ids, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
let port = 0;
let ops: Client;

beforeAll(async () => {
  app = await startApp({ AGENT_ENROLL_RATE_PER_MINUTE: '100' });
  const g = app.get(AgentGateway);
  await g.start(0, '127.0.0.1');
  port = g.address!.port;
  ops = await signedIn(app, EMAIL.ops);
});
afterAll(async () => {
  await app.get(AgentGateway).stop();
  await app.close();
});

const send = (a: AgentIdentity, body: unknown) => gw(port, '/agent/v1/reports', body, a.en.caCertificate, a);
const explorer = async (a: AgentIdentity) => (await ops.get(`/deployments/${a.en.deploymentId}/database`)).body;
const FP1 = '1'.repeat(32);
const FP2 = '2'.repeat(32);

describe('Database Explorer', () => {
  it('schema parts are projected per table; a completed snapshot removes tables that vanished', async () => {
    const a = await enrolledAgent(app, ops, port);
    expect((await send(a, healthyReports())).body).toMatchObject({ accepted: 9 });
    // Snapshot 1 in two parts: three tables.
    expect((await send(a, schemaPart(FP1, 1, 2, [tableSchema('helpdesk_tickets'), tableSchema('app_metadata')]))).body).toMatchObject({ accepted: 1, rejected: [] });
    let d = await explorer(a);
    expect(d.inspection).toMatchObject({ fingerprint: FP1, detailedTables: 2, pendingTables: 0 });
    expect((await send(a, schemaPart(FP1, 2, 2, [tableSchema('sync_runs')]))).body).toMatchObject({ accepted: 1 });
    d = await explorer(a);
    expect(d.tables.map((t: { name: string }) => t.name)).toEqual(['app_metadata', 'helpdesk_tickets', 'sync_runs']);
    expect(d.tables.find((t: { name: string }) => t.name === 'sync_runs')).toMatchObject({ estimatedRows: 0, sizeBytes: 40960, columns: 5, hasPrimaryKey: true, indexes: 2, foreignKeys: 1, kind: 'table' });
    // Snapshot 2: sync_runs is gone and helpdesk_tickets gained a column.
    const wider = tableSchema('helpdesk_tickets', { columns: [...tableSchema('x').columns, { position: 6, name: 'priority', type: 'smallint', nullable: true, default: null, identity: false }] });
    expect((await send(a, schemaPart(FP2, 1, 1, [wider, tableSchema('app_metadata')]))).body).toMatchObject({ accepted: 1 });
    d = await explorer(a);
    expect(d.tables.map((t: { name: string }) => t.name)).toEqual(['app_metadata', 'helpdesk_tickets']);
    expect(d.inspection.fingerprint).toBe(FP2);
    const t = (await ops.get(`/deployments/${a.en.deploymentId}/database/tables/public/helpdesk_tickets`)).body;
    expect(t.columns).toHaveLength(6);
    expect(t.columns[5]).toMatchObject({ name: 'priority', type: 'smallint', nullable: true });
    // An older part arriving late cannot overwrite the newer snapshot.
    const old = schemaPart(FP1, 1, 1, [tableSchema('helpdesk_tickets')], new Date(Date.now() - 60_000));
    expect((await send(a, old)).body).toMatchObject({ accepted: 1 });
    expect((await ops.get(`/deployments/${a.en.deploymentId}/database/tables/public/helpdesk_tickets`)).body.columns).toHaveLength(6);
    // Schema parts are not kept as report history; the inventory report is.
    await asApp({ orgId: (await ids()).orgA, scopeAll: true }, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM deployment_reports WHERE deployment_id = $1 AND report_type = 'database_schema'`, [a.en.deploymentId])).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int AS n FROM deployment_tables WHERE deployment_id = $1`, [a.en.deploymentId])).rows[0].n).toBe(2);
    });
  });

  it('the deployment view merges the inventory with details, labels estimates and groups inspection errors', async () => {
    const a = await enrolledAgent(app, ops, port);
    let d = await explorer(a);
    expect(d).toMatchObject({ database: null, tables: [], inspection: { lastInventoryAt: null, lastSchemaAt: null, detailedTables: 0, pendingTables: 0 }, errors: [] });
    await send(a, healthyReports({ database: { databaseName: 'psa_edge' } }));
    d = await explorer(a);
    expect(d.database).toMatchObject({ databaseName: 'psa_edge', available: true, serverVersion: '17.6', schemaVersion: '0002', migrationsApplied: 2, sizeBytes: 8_500_000, tableCount: 2, error: null });
    expect(d.tables).toEqual([
      expect.objectContaining({ name: 'app_metadata', estimatedRows: null, kind: null, detailsObservedAt: null }),
      expect.objectContaining({ name: 'helpdesk_tickets', estimatedRows: 0, columns: 17, detailsObservedAt: null }),
    ]);
    expect(d.inspection).toMatchObject({ detailedTables: 0, pendingTables: 2 });
    await send(a, schemaPart(FP1, 1, 1, [tableSchema('helpdesk_tickets')]));
    d = await explorer(a);
    expect(d.inspection).toMatchObject({ detailedTables: 1, pendingTables: 1 });
    expect(d.tables.find((t: { name: string }) => t.name === 'helpdesk_tickets')).toMatchObject({ kind: 'table', columns: 17 }); // inventory counts win over detail counts
    // Inventory failures are reported as codes and grouped.
    await send(a, healthyReports({ database: { available: false, error: 'database_unavailable', tables: [] } }));
    await send(a, healthyReports({ database: { available: false, error: 'database_unavailable', tables: [] } }, new Date(Date.now() + 1000)));
    d = await explorer(a);
    expect(d.errors).toEqual([expect.objectContaining({ code: 'database_unavailable', count: 2 })]);
    expect(d.database.available).toBe(false);
    expect(d.tables.map((t: { name: string }) => t.name)).toEqual(['helpdesk_tickets']); // details kept while the inventory is unavailable
    const t = (await ops.get(`/deployments/${a.en.deploymentId}/database/tables/public/helpdesk_tickets`)).body;
    expect(t).toMatchObject({ schema: 'public', name: 'helpdesk_tickets', fingerprint: FP1, inventory: null });
    expect(t.primaryKey).toEqual({ name: 'helpdesk_tickets_pkey', columns: ['id'] });
    expect(t.foreignKeys[0]).toMatchObject({ referencedTable: 'psa_connections', onDelete: 'restrict' });
    expect(t.stats).toMatchObject({ estimatedRows: 0, totalBytes: 40960 });
    expect((await ops.get(`/deployments/${a.en.deploymentId}/database/tables/public/nope`)).status).toBe(404);
    expect((await ops.get(`/deployments/${a.en.deploymentId}/database/tables/${'x'.repeat(65)}/nope`)).status).toBe(400);
  });

  it('strict schema reports: anything beyond catalog metadata is rejected and audited without the content', async () => {
    const a = await enrolledAgent(app, ops, port);
    const bad = [
      tableSchema('helpdesk_tickets', { rows: [{ subject: 'SECRET TICKET BODY' }] }),
      tableSchema('helpdesk_tickets', { columns: [{ position: 1, name: 'id', type: 'uuid', nullable: false, default: null, identity: false, sample: 'SECRET VALUE' }] }),
      tableSchema('helpdesk_tickets', { indexes: [{ name: 'i', unique: false, primary: false, definition: 'SECRET\u0000BINARY', sizeBytes: 1 }] }),
    ];
    for (const t of bad) {
      const r = await send(a, schemaPart(FP1, 1, 1, [t]));
      expect(r.status, JSON.stringify(r.body)).toBe(400); // nothing in the batch was acceptable
      expect(r.body).toMatchObject({ accepted: 0 });
      expect((r.body.rejected as { type: string }[])[0]!.type).toBe('database_schema');
    }
    expect((await send(a, schemaPart(FP1, 2, 1, [tableSchema('helpdesk_tickets')]))).body).toMatchObject({ accepted: 0 }); // part > parts
    expect((await explorer(a)).inspection.detailedTables).toBe(0);
    const audit = (await ops.get(`/audit-events?action=agent.report.rejected&pageSize=50`)).body;
    const mine = audit.items.filter((e: { targetId: string }) => e.targetId === a.en.deploymentId);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audit)).not.toMatch(/SECRET/);
    await asApp(null, async (c) => {
      expect((await c.query(`SELECT count(*)::int AS n FROM deployment_tables WHERE deployment_id = $1`, [a.en.deploymentId])).rows[0].n).toBe(0);
    });
  });

  it('fleet view separates synthetic records, filters by availability, and honours RBAC and tenant isolation', async () => {
    const a = await enrolledAgent(app, ops, port);
    await send(a, healthyReports({ database: { databaseName: 'psa_edge' } }));
    await send(a, schemaPart(FP1, 1, 1, [tableSchema('helpdesk_tickets')]));
    const all = (await ops.get('/database-explorer')).body;
    expect(all.summary.synthetic).toBeGreaterThan(0);
    const mine = all.rows.find((r: { id: string }) => r.id === a.en.deploymentId);
    expect(mine).toMatchObject({ isSynthetic: false, detailedTables: 1, database: { databaseName: 'psa_edge', available: true, serverVersion: '17.6', tableCount: 2 } });
    expect(all.rows.filter((r: { isSynthetic: boolean }) => r.isSynthetic).every((r: { database: unknown }) => r.database === null)).toBe(true);
    const live = (await ops.get('/database-explorer?live=1')).body;
    expect(live.rows.every((r: { isSynthetic: boolean }) => !r.isSynthetic)).toBe(true);
    expect(live.summary.synthetic).toBe(0);
    expect((await ops.get('/database-explorer?availability=unavailable')).body.rows.some((r: { id: string }) => r.id === a.en.deploymentId)).toBe(false);
    expect((await ops.get('/database-explorer?availability=available')).body.rows.some((r: { id: string }) => r.id === a.en.deploymentId)).toBe(true);
    expect((await ops.get(`/database-explorer?q=${a.en.deploymentCode}`)).body.rows.map((r: { id: string }) => r.id)).toEqual([a.en.deploymentId]);
    expect((await ops.get('/database-explorer?availability=sometimes')).status).toBe(400);
    // RBAC: read_only lacks database.metadata.read; the auditor and security admin may read; nobody can write.
    const viewer = await signedIn(app, EMAIL.viewer);
    expect((await viewer.get('/database-explorer')).status).toBe(403);
    expect((await viewer.get(`/deployments/${a.en.deploymentId}/database`)).status).toBe(403);
    for (const email of [EMAIL.auditor, EMAIL.security]) {
      const c = await signedIn(app, email);
      expect((await c.get('/database-explorer')).status, email).toBe(200);
      expect((await c.get(`/deployments/${a.en.deploymentId}/database/tables/public/helpdesk_tickets`)).status, email).toBe(200);
    }
    expect((await ops.post(`/deployments/${a.en.deploymentId}/database/tables/public/helpdesk_tickets`, {})).status).toBe(404);
    const tech = await signedIn(app, EMAIL.technician);
    expect((await tech.get(`/deployments/${a.en.deploymentId}/database`)).status).toBe(404); // not an assigned client
    expect((await tech.get('/database-explorer')).body.rows.some((r: { id: string }) => r.id === a.en.deploymentId)).toBe(false);
    const b = await signedIn(app, EMAIL.orgB);
    expect((await b.get(`/deployments/${a.en.deploymentId}/database`)).status).toBe(404);
    expect((await b.get(`/deployments/${a.en.deploymentId}/database/tables/public/helpdesk_tickets`)).status).toBe(404);
    expect((await b.get('/database-explorer')).body.rows.every((r: { id: string }) => r.id !== a.en.deploymentId)).toBe(true);
    await asApp(null, async (c) => {
      expect((await c.query('SELECT count(*)::int AS n FROM deployment_tables')).rows[0].n).toBe(0); // no tenant context: RLS hides every row
    });
  });
});
