import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { unzipSync } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestLicense } from './agent-helpers.js';
import { type Client, EMAIL, ORIGIN, asApp, asAppCommit, fileEnv, ids, signedIn, startApp } from './helpers.js';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(async () => {
  await app.close();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function inOrgA<T>(fn: (c: import('pg').Client) => Promise<T>) {
  const { orgA } = await ids();
  return asApp({ orgId: orgA, scopeAll: true }, fn);
}
/** Committed change behind the API's back (asApp rolls back). */
async function commitOrgA(sql: string, params: unknown[]) {
  const { orgA } = await ids();
  await asAppCommit({ orgId: orgA }, (c) => c.query(sql, params));
}
async function assignedClients(email: string) {
  const { user } = await ids();
  return inOrgA(async (c) => (await c.query<{ client_id: string; code: string }>(
    // Newest assignment first: CL-00001's seeded counts are asserted by the clients tests.
    'SELECT a.client_id, c.code FROM user_client_assignments a JOIN clients c ON c.id = a.client_id WHERE a.user_id = $1 ORDER BY c.code DESC',
    [user(email)],
  )).rows);
}
async function clientByCode(code: string) {
  return inOrgA(async (c) => (await c.query('SELECT id FROM clients WHERE code = $1', [code])).rows[0].id as string);
}
async function activePsa(clientId: string) {
  return inOrgA(async (c) => (await c.query(`SELECT id FROM psa_instances WHERE client_id = $1 AND status = 'active' ORDER BY code LIMIT 1`, [clientId])).rows[0].id as string);
}

/** Binary-safe package download through the real HTTP stack (CSRF + Origin like the browser). */
async function download(c: Client, path: string) {
  const res = await request(app.getHttpServer())
    .post(`/api/v1${path}`)
    .set('cookie', c.cookieHeader)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.cookies.get('psacc_csrf') ?? '')
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return res as request.Response & { body: Buffer };
}

async function newDeployment(c: Client, clientCode = 'CL-00014', over: Record<string, unknown> = {}) {
  const clientId = await clientByCode(clientCode);
  await ensureTestLicense(await signedIn(app, EMAIL.ops), clientId); // Module 14: packages need an active license
  const r = await c.post('/deployments', { clientId, psaInstanceId: await activePsa(clientId), targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'it-edge-01', ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; code: string; client: { id: string } };
}

describe('deployment records', () => {
  it('creates a draft deployment for a client with validation and RBAC', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const clientId = await clientByCode('CL-00014');
    const psaInstanceId = await activePsa(clientId);
    const base = { clientId, psaInstanceId, targetEnvironment: 'linux_docker', targetOs: 'linux', targetArch: 'amd64' };
    for (const email of [EMAIL.viewer, EMAIL.technician, EMAIL.auditor, EMAIL.service]) {
      expect((await (await signedIn(app, email)).post('/deployments', base)).status, email).toBe(403);
    }
    expect((await ops.post('/deployments', { ...base, targetOs: 'windows' })).body.errors[0].path).toBe('targetOs');
    expect((await ops.post('/deployments', { ...base, targetArch: 'x86' })).status).toBe(400);
    expect((await ops.post('/deployments', { ...base, hostLabel: 'bad;label' })).body.errors[0].path).toBe('hostLabel');
    const otherClientPsa = await activePsa(await clientByCode('CL-00001'));
    expect((await ops.post('/deployments', { ...base, psaInstanceId: otherClientPsa })).body.errors[0].path).toBe('psaInstanceId');
    expect((await ops.post('/deployments', { ...base, clientId: '00000000-0000-4000-8000-000000000000' })).body.errors[0].path).toBe('clientId');

    const r = await ops.post('/deployments', { ...base, hostLabel: 'orchid-edge' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: expect.stringMatching(/^DEP-\d{5}$/), lifecycleState: 'draft', healthState: 'unknown', currentPackage: null, packages: [], isSynthetic: false });
    expect(r.body.readiness.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect((await ops.get(`/deployments/${r.body.id}/activity`)).body.items[0]).toMatchObject({ action: 'deployment.created' });
  });

  it('lists with server-side search, filters, sort and lifecycle stats', async () => {
    const v = await signedIn(app, EMAIL.viewer);
    const all = (await v.get('/deployments?pageSize=100')).body;
    expect(all.total).toBeGreaterThanOrEqual(27);
    const verified = (await v.get('/deployments?lifecycle=verified&pageSize=100')).body.items;
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.every((d: { lifecycleState: string }) => d.lifecycleState === 'verified')).toBe(true);
    expect((await v.get('/deployments?q=Bluepeak')).body.items.every((d: { client: { displayName: string } }) => d.client.displayName === 'Bluepeak Logistics')).toBe(true);
    const sorted = (await v.get('/deployments?sort=code:asc&pageSize=5')).body.items.map((d: { code: string }) => d.code);
    expect([...sorted].sort()).toEqual(sorted);
    expect((await v.get('/deployments?lifecycle=installed')).status).toBe(400);
    expect((await v.get('/deployments?sort=password:asc')).status).toBe(400);
    const stats = (await v.get('/deployments/stats')).body;
    expect(stats.total).toBe(all.total);
    expect(stats.verified).toBe(verified.length);
    const t = await signedIn(app, EMAIL.technician);
    const mine = (await t.get('/deployments?pageSize=100')).body.items as { client: { id: string } }[];
    const assigned = (await assignedClients(EMAIL.technician)).map((r) => r.client_id);

    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((d) => assigned.includes(d.client.id))).toBe(true);
  });

  it('settings change only while no package exists, with optimistic concurrency', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const d = (await ops.get(`/deployments/${dep.id}`)).body;
    const body = { version: d.version, psaInstanceId: d.psaInstance.id, targetEnvironment: 'cloud_vm', targetOs: 'linux', targetArch: 'arm64', hostLabel: 'cloud-1' };
    const r = await ops.patch(`/deployments/${dep.id}`, body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ targetEnvironment: 'cloud_vm', targetArch: 'arm64' });
    expect((await ops.patch(`/deployments/${dep.id}`, body)).status).toBe(409); // stale version
    expect((await ops.get(`/deployments/${dep.id}/activity`)).body.items[0].metadata.changes.targetArch).toEqual({ from: 'amd64', to: 'arm64' });
    await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 });
    const locked = await ops.patch(`/deployments/${dep.id}`, { ...body, version: (await ops.get(`/deployments/${dep.id}`)).body.version });
    expect(locked.status).toBe(409);
    expect(locked.body.type).toBe('urn:psacc:problem:package-exists');
    expect((await (await signedIn(app, EMAIL.viewer)).patch(`/deployments/${dep.id}`, body)).status).toBe(403);
  });
});

describe('package generation', () => {
  it('validates the client, PSA instance and services first, and refuses synthetic records', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const synthetic = (await ops.get('/deployments?q=DEP-00001')).body.items[0];
    const r = await ops.post(`/deployments/${synthetic.id}/packages`, { tokenValidityHours: 24 });
    expect(r.status).toBe(422);
    expect(r.body.type).toBe('urn:psacc:problem:not-ready');
    expect((await ops.get(`/deployments/${synthetic.id}`)).body.readiness.find((c: { key: string }) => c.key === 'record')).toMatchObject({ ok: false });

    const dep = await newDeployment(ops);
    // Break the PSA configuration behind the API's back: the adapter re-validates before generation.
    const original = await inOrgA(async (c) => (await c.query('SELECT i.config, i.api_endpoint, cl.status FROM deployments d JOIN psa_instances i ON i.id = d.psa_instance_id JOIN clients cl ON cl.id = d.client_id WHERE d.id = $1', [dep.id])).rows[0]);
    const originalStatus = original.status as string;
    await commitOrgA(`UPDATE psa_instances SET config = '{"zone":"webservices99"}' WHERE id = (SELECT psa_instance_id FROM deployments WHERE id = $1)`, [dep.id]);
    const bad = await ops.get(`/deployments/${dep.id}`);
    expect(bad.body.readiness.find((c: { key: string }) => c.key === 'psa_config')).toMatchObject({ ok: false });
    expect((await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).status).toBe(422);
    await commitOrgA(`UPDATE psa_instances SET config = $2, api_endpoint = $3 WHERE id = (SELECT psa_instance_id FROM deployments WHERE id = $1)`, [dep.id, original.config, original.api_endpoint]);

    await commitOrgA(`UPDATE clients SET status = 'suspended' WHERE id = $1`, [dep.client.id]);
    expect((await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).body.detail).toMatch(/suspended/);
    await commitOrgA(`UPDATE clients SET status = $2 WHERE id = $1`, [dep.client.id, originalStatus]);

    for (const h of [0, 2, 73, 168]) expect((await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: h })).status, String(h)).toBe(400);
  });

  it('generates a package: installation identity, single-use token stored only as a hash, encrypted archive, audit', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const r = await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 4 });
    expect(r.status).toBe(201);
    expect(r.body.lifecycleState).toBe('package_generated');
    const p = r.body.currentPackage;
    expect(p).toMatchObject({ number: 1, status: 'active', downloadable: true, downloadCount: 0, image: { repository: 'psacc/psa-edge' } });
    expect(new Date(p.token.expiresAt).getTime() - new Date(p.token.issuedAt).getTime()).toBe(4 * 3_600_000);
    expect(p.token.prefix).toMatch(/^psacc_enr_[A-Za-z0-9_-]{4}…$/);
    expect(JSON.stringify(r.body)).not.toMatch(/psacc_enr_[A-Za-z0-9_-]{20,}/); // the token is never returned

    const rows = await inOrgA(async (c) => (await c.query(
      `SELECT t.token_hash, pk.archive_ciphertext, pk.config_snapshot::text AS cfg, pk.manifest::text AS manifest FROM deployment_packages pk JOIN enrollment_tokens t ON t.package_id = pk.id WHERE pk.id = $1`,
      [p.id],
    )).rows[0]);
    expect(rows.archive_ciphertext).toMatch(/^v1\./);
    expect(rows.token_hash).toHaveLength(32);
    const audit = (await ops.get(`/deployments/${dep.id}/activity`)).body.items[0];
    expect(audit).toMatchObject({ action: 'deployment.package.generated', metadata: { packageNumber: 1, sha256: p.sha256, validityHours: 4 } });

    // The downloaded archive's token matches the stored hash; nothing readable is stored anywhere else.
    const dl = await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`);
    const files = unzipSync(new Uint8Array(dl.body));
    const enrollment = JSON.parse(Buffer.from(files[`psacc-${dep.code.toLowerCase()}/enrollment/enrollment.json`]!).toString());
    expect(createHash('sha256').update(enrollment.token).digest()).toEqual(rows.token_hash);
    for (const stored of [rows.archive_ciphertext, rows.cfg, rows.manifest, JSON.stringify(audit)]) expect(stored).not.toContain(enrollment.token);
    const auditRows = await inOrgA(async (c) => (await c.query(`SELECT metadata::text AS m FROM audit_events WHERE target_id = $1`, [dep.id])).rows);
    for (const a of auditRows) expect(a.m).not.toContain(enrollment.token);
  });

  it('download: ZIP with matching SHA-256, recorded per download, lifecycle moves to downloaded (not installed)', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).body.currentPackage;
    const dl = await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="psacc-${dep.code.toLowerCase()}-package-1.zip"`);
    expect(dl.headers['cache-control']).toBe('no-store');
    expect(sha(dl.body)).toBe(p.sha256);
    expect(dl.headers['x-content-sha256']).toBe(p.sha256);

    const files = unzipSync(new Uint8Array(dl.body));
    const root = `psacc-${dep.code.toLowerCase()}/`;
    const cfg = JSON.parse(Buffer.from(files[`${root}config/edge.json`]!).toString());
    expect(cfg).toMatchObject({ deployment: { id: dep.id, installationId: p.installationId }, client: { id: dep.client.id } });
    const env = fileEnv();
    for (const [name, data] of Object.entries(files)) {
      const t = Buffer.from(data).toString();
      for (const secret of [env.DATA_ENCRYPTION_KEY!, env.CSRF_SECRET!, env.SEED_DEFAULT_PASSWORD!, env.DATABASE_URL!]) expect(t.includes(secret), name).toBe(false);
    }

    const d = (await ops.get(`/deployments/${dep.id}`)).body;
    expect(d).toMatchObject({ lifecycleState: 'package_downloaded', enrolledAt: null, currentPackage: { downloadCount: 1 } });
    expect(d.packageDownloadedAt).not.toBeNull();
    await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`);
    expect((await ops.get(`/deployments/${dep.id}`)).body.currentPackage.downloadCount).toBe(2);
    const audit = (await ops.get(`/deployments/${dep.id}/activity`)).body.items;
    expect(audit.filter((e: { action: string }) => e.action === 'deployment.package.downloaded').map((e: { metadata: { downloadNumber: number } }) => e.metadata.downloadNumber)).toEqual([2, 1]);
    const rows = await inOrgA(async (c) => (await c.query('SELECT sha256, user_agent FROM deployment_package_downloads WHERE package_id = $1', [p.id])).rows);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sha256 === p.sha256)).toBe(true);
  });

  it('regenerating requires confirmation, supersedes the old package and revokes its token', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p1 = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).body.currentPackage;
    const again = await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 });
    expect(again.status).toBe(409);
    expect(again.body.type).toBe('urn:psacc:problem:package-exists');
    const r = await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24, replaceExisting: true });
    expect(r.status).toBe(201);
    expect(r.body.currentPackage.number).toBe(2);
    expect(r.body.currentPackage.installationId).not.toBe(p1.installationId);
    const old = r.body.packages.find((p: { number: number }) => p.number === 1);
    expect(old).toMatchObject({ status: 'superseded', downloadable: false, token: { status: 'revoked' } });
    const stale = await download(ops, `/deployments/${dep.id}/packages/${p1.id}/download`);
    expect(stale.status).toBe(410);
    expect(JSON.parse(stale.body.toString()).type).toBe('urn:psacc:problem:package-unavailable');
    expect((await inOrgA((c) => c.query('SELECT archive_ciphertext FROM deployment_packages WHERE id = $1', [p1.id]))).rows[0].archive_ciphertext).toBeNull();
    expect((await ops.get(`/deployments/${dep.id}/activity`)).body.items[0].metadata.supersededPackage).toBe(1);
  });

  it('revoke needs a reason, kills the token, purges the archive and returns the deployment to draft', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).body.currentPackage;
    expect((await ops.post(`/deployments/${dep.id}/packages/${p.id}/revoke`, { reason: 'no' })).status).toBe(400);
    const r = await ops.post(`/deployments/${dep.id}/packages/${p.id}/revoke`, { reason: 'Sent to the wrong client contact' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ lifecycleState: 'draft', currentPackage: null });
    expect(r.body.packages[0]).toMatchObject({ status: 'revoked', revokeReason: 'Sent to the wrong client contact', token: { status: 'revoked' } });
    expect((await ops.post(`/deployments/${dep.id}/packages/${p.id}/revoke`, { reason: 'again please' })).status).toBe(409);
    expect((await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`)).status).toBe(410);
    expect((await ops.get(`/deployments/${dep.id}/activity`)).body.items[0]).toMatchObject({ action: 'deployment.package.revoked', metadata: { reason: 'Sent to the wrong client contact' } });
  });

  it('expired tokens: the package expires, its archive is purged, the deployment returns to draft (system audit)', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
    await commitOrgA(`UPDATE enrollment_tokens SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE package_id = $1`, [p.id]);
    const d = (await ops.get(`/deployments/${dep.id}`)).body;
    expect(d.lifecycleState).toBe('draft');
    expect(d.packages[0]).toMatchObject({ status: 'expired', downloadable: false, token: { status: 'expired' } });
    expect((await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`)).status).toBe(410);
    expect((await ops.get(`/deployments/${dep.id}/activity`)).body.items[0]).toMatchObject({ action: 'deployment.package.expired', actorType: 'system' });
    // A fresh package can be generated afterwards; only one token is ever open.
    expect((await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).status).toBe(201);
    const open = await inOrgA(async (c) => (await c.query('SELECT count(*)::int AS n FROM enrollment_tokens WHERE deployment_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL', [dep.id])).rows[0].n);
    expect(open).toBe(1);
  });

  it('the periodic sweep expires packages across organizations without leaking tenant context', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
    await commitOrgA(`UPDATE enrollment_tokens SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE package_id = $1`, [p.id]);
    const n = await asApp(null, async (c) => (await c.query('SELECT app_expire_deployment_packages() AS n')).rows[0].n as number);
    expect(n).toBeGreaterThanOrEqual(1);
    const { orgA } = await ids();
    await asApp({ orgId: orgA, scopeAll: true }, async (c) => {
      await c.query('SELECT app_expire_deployment_packages($1)', [orgA]);
      // The caller's context survives the SECURITY DEFINER call.
      expect((await c.query(`SELECT current_setting('app.org_id', true) AS o`)).rows[0].o).toBe(orgA);
      expect((await c.query('SELECT status FROM deployment_packages WHERE id = $1', [p.id])).rows[0].status).toBe('expired');
    });
  });
});

describe('package permissions and isolation', () => {
  it('read-only and auditors see metadata but cannot generate, download or revoke', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).body.currentPackage;
    for (const email of [EMAIL.viewer, EMAIL.auditor]) {
      const c = await signedIn(app, email);
      expect((await c.get(`/deployments/${dep.id}`)).body.currentPackage.sha256).toBe(p.sha256);
      expect((await c.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24, replaceExisting: true })).status, email).toBe(403);
      expect((await download(c, `/deployments/${dep.id}/packages/${p.id}/download`)).status, email).toBe(403);
      expect((await c.post(`/deployments/${dep.id}/packages/${p.id}/revoke`, { reason: 'not allowed' })).status, email).toBe(403);
    }
  });

  it('technicians generate and download only for their assigned clients', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const [assigned] = await assignedClients(EMAIL.technician);

    const mine = await newDeployment(ops, assigned!.code);
    const theirs = await newDeployment(ops, 'CL-00014');
    const t = await signedIn(app, EMAIL.technician);
    const r = await t.post(`/deployments/${mine.id}/packages`, { tokenValidityHours: 4 });
    expect(r.status).toBe(201);
    expect((await download(t, `/deployments/${mine.id}/packages/${r.body.currentPackage.id}/download`)).status).toBe(200);
    expect((await t.get(`/deployments/${theirs.id}`)).status).toBe(404);
    expect((await t.post(`/deployments/${theirs.id}/packages`, { tokenValidityHours: 4 })).status).toBe(404);
  });

  it('organization B cannot see, generate, download or revoke organization A packages; RLS fails closed', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).body.currentPackage;
    const b = await signedIn(app, EMAIL.orgB);
    expect((await b.get(`/deployments/${dep.id}`)).status).toBe(404);
    expect((await b.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).status).toBe(404);
    expect((await download(b, `/deployments/${dep.id}/packages/${p.id}/download`)).status).toBe(404);
    expect((await b.post(`/deployments/${dep.id}/packages/${p.id}/revoke`, { reason: 'cross-tenant' })).status).toBe(404);
    expect((await b.get('/deployments?pageSize=100')).body.items.every((d: { code: string }) => d.code !== dep.code)).toBe(true);
    await asApp(null, async (c) => {
      for (const t of ['deployment_packages', 'enrollment_tokens', 'deployment_package_downloads']) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
      }
    });
  });

  it('database rules: one usable package and one open token per deployment, at most 72 h, downloads append-only', async () => {
    const ops = await signedIn(app, EMAIL.ops);
    const dep = await newDeployment(ops);
    const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 24 })).body.currentPackage;
    await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`);
    await inOrgA(async (c) => {
      await expect(c.query(`UPDATE enrollment_tokens SET expires_at = issued_at + interval '73 hours' WHERE package_id = $1`, [p.id])).rejects.toThrow(/enrollment_tokens_lifetime/);
    });
    await inOrgA(async (c) => {
      await expect(c.query(`UPDATE deployment_packages SET status = 'revoked', revoked_at = now(), revoke_reason = 'test' WHERE id = $1`, [p.id])).rejects.toThrow(/archive_only_when_active/);
    });
    await inOrgA(async (c) => {
      await expect(c.query('UPDATE deployment_package_downloads SET sha256 = $2 WHERE package_id = $1', [p.id, 'f'.repeat(64)])).rejects.toThrow(/permission denied/);
    });
    await inOrgA(async (c) => {
      await expect(c.query('DELETE FROM deployment_packages WHERE id = $1', [p.id])).rejects.toThrow(/permission denied/);
    });
  });
});
