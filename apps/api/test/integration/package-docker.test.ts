/**
 * Real Docker checks of generated deployment packages (Module 5).
 *
 * Two packages are generated through the API — one for an Autotask client, one for a ConnectWise
 * client — then extracted and checked with the real Docker Engine: Compose validation (development
 * and production), script syntax, file modes, checksums, the install script's --prepare mode, and
 * each package's own PostgreSQL container started side by side to prove separate projects, volumes,
 * networks and credentials, no published database port, and persistence across restarts.
 *
 * The PSA Edge image itself is built in Module 6, so only the database service is started here.
 * Everything uses `psacc-dep-*` Compose projects and is removed afterwards. If Docker is not
 * reachable the suite is skipped and reported as BLOCKED, never as passed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTestLicense } from './agent-helpers.js';
import { type Client, EMAIL, ORIGIN, asApp, ids, signedIn, startApp } from './helpers.js';

const WSL = process.platform === 'win32';
/** Runs a bash command where Docker lives (WSL on this workstation, natively on Linux). */
function sh(cmd: string, timeout = 180_000) {
  const r = WSL ? spawnSync('wsl', ['--exec', 'bash', '-c', cmd], { encoding: 'utf8', timeout }) : spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}`.trim(), err: `${r.stderr ?? ''}`.trim() };
}
const dockerAvailable = sh('docker info --format "{{.ServerVersion}}" && docker compose version --short && docker image inspect postgres:17-alpine --format ok', 60_000).code === 0;
if (!dockerAvailable) console.warn('BLOCKED: Docker Engine (with Compose and postgres:17-alpine) is not reachable; package Docker tests are skipped.');

let app: NestExpressApplication;
let winTmp = '';
const work = `/tmp/psacc-pkgtest-${process.pid}`;
const pkgs: { code: string; project: string; dir: string; provider: string }[] = [];

async function download(c: Client, path: string): Promise<Buffer> {
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
  expect(res.status).toBe(200);
  return res.body as Buffer;
}

const toUnix = (winPath: string) => (WSL ? sh(`wslpath -a '${winPath.replace(/'/g, "'\\''")}'`).out : winPath);
/** Never install over a Compose project that already exists on this engine: it could be a real appliance (its cleanup would remove it). */
function refuseExistingProject(project: string): void {
  const containers = sh(`docker ps -aq --filter label=com.docker.compose.project=${project} | wc -l`).out.trim();
  const volumes = sh(`docker volume ls -q --filter label=com.docker.compose.project=${project} | wc -l`).out.trim();
  if (containers !== '0' || volumes !== '0') throw new Error(`refusing to install ${project}: a Compose project with that name already exists on this engine (${containers} containers, ${volumes} volumes)`);
}

describe.skipIf(!dockerAvailable)('generated packages on a real Docker Engine', () => {
  beforeAll(async () => {
    app = await startApp();
    winTmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'psacc-pkg-')));
    const ops = await signedIn(app, EMAIL.ops);
    const { orgA } = await ids();
    for (const provider of ['autotask', 'connectwise']) {
      // A client whose active PSA instance uses this provider (Test Client A: Autotask, B: ConnectWise).
      const row = await asApp({ orgId: orgA, scopeAll: true }, async (c) => (await c.query(
        `SELECT i.id AS psa, i.client_id FROM psa_instances i JOIN clients cl ON cl.id = i.client_id
         WHERE i.provider_key = $1 AND i.status = 'active' AND cl.status NOT IN ('suspended', 'offboarded')
           AND EXISTS (SELECT 1 FROM psa_instance_services s WHERE s.psa_instance_id = i.id) ORDER BY i.code DESC LIMIT 1`,
        [provider],
      )).rows[0]);
      await ensureTestLicense(ops, row.client_id as string);
      const dep = (await ops.post('/deployments', { clientId: row.client_id, psaInstanceId: row.psa, targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64', hostLabel: `docker-${provider}` })).body;
      const p = (await ops.post(`/deployments/${dep.id}/packages`, { tokenValidityHours: 1 })).body.currentPackage;
      const zip = await download(ops, `/deployments/${dep.id}/packages/${p.id}/download`);
      const file = join(winTmp, p.fileName);
      writeFileSync(file, zip);
      const project = `psacc-${dep.code.toLowerCase()}`;
      refuseExistingProject(project);
      const r = sh(`set -e; mkdir -p ${work}/${project}-x && cd ${work}/${project}-x && unzip -q "${toUnix(file)}"`);
      expect(r.code, r.err).toBe(0);
      pkgs.push({ code: dep.code, project, dir: `${work}/${project}-x/${project}`, provider });
    }
  }, 240_000);

  afterAll(async () => {
    for (const p of pkgs) sh(`cd ${p.dir} && docker compose -f compose.yaml down --volumes --remove-orphans`, 120_000);
    sh(`rm -rf ${work}`);
    if (winTmp) rmSync(winTmp, { recursive: true, force: true });
    await app?.close();
  }, 240_000);

  it('checksums verify, scripts parse, and file modes survive extraction on Linux', () => {
    for (const p of pkgs) {
      expect(sh(`cd ${p.dir} && sha256sum --quiet -c CHECKSUMS.sha256`).code, p.code).toBe(0);
      expect(sh(`cd ${p.dir} && bash -n scripts/install.sh && bash -n scripts/verify.sh`).code, p.code).toBe(0);
      expect(sh(`cd ${p.dir} && stat -c '%a %n' scripts/install.sh scripts/verify.sh enrollment/enrollment.json`).out.split('\n')).toEqual([
        '755 scripts/install.sh', '755 scripts/verify.sh', '600 enrollment/enrollment.json',
      ]);
    }
  });

  it('Compose accepts the development configuration; production refuses unpinned images and accepts pinned ones', () => {
    const pin = `PSA_EDGE_IMAGE=psacc/psa-edge@sha256:${'0'.repeat(64)} PSA_POSTGRES_IMAGE=postgres:17-alpine@sha256:${'1'.repeat(64)}`;
    for (const p of pkgs) {
      const dev = sh(`cd ${p.dir} && docker compose -f compose.yaml config --quiet`);
      expect(dev.code, dev.err).toBe(0);
      // Each image must be pinned on its own: leave one unset at a time.
      const noEdge = sh(`cd ${p.dir} && env -u PSA_EDGE_IMAGE PSA_POSTGRES_IMAGE=postgres:17-alpine@sha256:${'1'.repeat(64)} docker compose -f compose.yaml -f compose.production.yaml config --quiet`);
      expect(noEdge.code).not.toBe(0);
      expect(noEdge.err).toContain('Set PSA_EDGE_IMAGE to the signed PSA Edge image pinned by digest');
      const noPg = sh(`cd ${p.dir} && env -u PSA_POSTGRES_IMAGE PSA_EDGE_IMAGE=psacc/psa-edge@sha256:${'0'.repeat(64)} docker compose -f compose.yaml -f compose.production.yaml config --quiet`);
      expect(noPg.code).not.toBe(0);
      expect(noPg.err).toContain('Set PSA_POSTGRES_IMAGE to the PostgreSQL 17 image pinned by digest');
      const prod = sh(`cd ${p.dir} && ${pin} docker compose -f compose.yaml -f compose.production.yaml config --quiet`);
      expect(prod.code, prod.err).toBe(0);
      const rendered = JSON.parse(sh(`cd ${p.dir} && docker compose -f compose.yaml config --format json`).out);
      expect(rendered.name).toBe(p.project);
      expect(rendered.services['edge-postgres'].ports ?? []).toEqual([]);
      expect(rendered.services['edge-api'].ports[0]).toMatchObject({ host_ip: '127.0.0.1', target: 8480 });
      expect(rendered.networks['edge-internal'].internal).toBe(true);
      for (const s of ['edge-migrate', 'edge-api', 'edge-worker', 'edge-agent']) {
        expect(rendered.services[s], s).toMatchObject({ read_only: true, cap_drop: ['ALL'], user: '10001:10001' });
      }
    }
  });

  it('install.sh --prepare creates host-only secrets (0700 dir) and .env, idempotently', () => {
    for (const p of pkgs) {
      const r = sh(`cd ${p.dir} && scripts/install.sh --prepare`);
      expect(r.code, r.err || r.out).toBe(0);
      expect(r.out).toContain(`Prepared ${p.code}`);
      expect(sh(`cd ${p.dir} && stat -c '%a' secrets enrollment && stat -c '%a %s' secrets/postgres_owner_password secrets/data_key`).out.split('\n')).toEqual(['700', '700', '444 44', '444 44']);
      const before = sh(`cd ${p.dir} && sha256sum secrets/*`).out;
      const again = sh(`cd ${p.dir} && scripts/install.sh --prepare`);
      expect(again.out).toContain('kept     postgres_owner_password');
      expect(sh(`cd ${p.dir} && sha256sum secrets/*`).out).toBe(before);
      expect(sh(`cd ${p.dir} && test -f .env && grep -c '^EDGE_LOCAL_ADMIN_PORT=' .env`).out).toBe('1');
    }
    // Each installation generated its own secrets.
    expect(sh(`cat ${pkgs[0]!.dir}/secrets/postgres_owner_password`).out).not.toBe(sh(`cat ${pkgs[1]!.dir}/secrets/postgres_owner_password`).out);
  });

  it('each package runs its own PostgreSQL: separate project, volume and internal network, no published port', () => {
    for (const p of pkgs) {
      const up = sh(`cd ${p.dir} && docker compose -f compose.yaml up -d --wait --wait-timeout 120 edge-postgres`, 200_000);
      expect(up.code, up.err).toBe(0);
    }
    const [a, b] = pkgs as [(typeof pkgs)[0], (typeof pkgs)[0]];
    for (const p of pkgs) {
      expect(sh(`docker volume ls --format '{{.Name}}' | grep -x ${p.project}_pgdata`).code, p.project).toBe(0);
      expect(sh(`docker network inspect ${p.project}_edge-internal --format '{{.Internal}}'`).out).toBe('true');
      expect(sh(`docker inspect ${p.project}-edge-postgres-1 --format '{{json .HostConfig.PortBindings}}'`).out).toMatch(/^(\{\}|null)$/);
      const q = sh(`cd ${p.dir} && docker compose -f compose.yaml exec -T edge-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_owner_password)" psql -h 127.0.0.1 -U psa_edge_owner -d psa_edge -tAc "SELECT current_user || chr(32) || current_database()"'`);
      expect(q.out, q.err).toBe('psa_edge_owner psa_edge');
    }
    // Client B's password does not open client A's database, and A cannot even reach B's database.
    const wrong = sh(`cd ${a.dir} && docker compose -f compose.yaml exec -T -e PGPASSWORD="$(cat ${b.dir}/secrets/postgres_owner_password)" edge-postgres psql -h 127.0.0.1 -U psa_edge_owner -d psa_edge -tAc 'SELECT 1'`);
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toMatch(/password authentication failed/);
    const reach = sh(`cd ${a.dir} && docker compose -f compose.yaml exec -T edge-postgres pg_isready -t 3 -h ${b.project}-edge-postgres-1`);
    expect(reach.code).not.toBe(0);
  }, 300_000);

  it('data lives in the volume: it survives a container restart and a down/up', () => {
    const p = pkgs[0]!;
    const psql = (sql: string) => sh(`cd ${p.dir} && docker compose -f compose.yaml exec -T edge-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_owner_password)" psql -h 127.0.0.1 -U psa_edge_owner -d psa_edge -tAc "${sql}"'`);
    // SQL without quotes: it is nested in bash and sh quoting.
    expect(psql('CREATE TABLE persistence_probe (v text); INSERT INTO persistence_probe SELECT current_database() || chr(47) || current_user').code).toBe(0);
    expect(sh(`cd ${p.dir} && docker compose -f compose.yaml restart edge-postgres && docker compose -f compose.yaml up -d --wait --wait-timeout 120 edge-postgres`, 200_000).code).toBe(0);
    expect(psql('SELECT v FROM persistence_probe').out).toBe('psa_edge/psa_edge_owner');
    expect(sh(`cd ${p.dir} && docker compose -f compose.yaml down && docker compose -f compose.yaml up -d --wait --wait-timeout 120 edge-postgres`, 200_000).code).toBe(0);
    expect(psql('SELECT v FROM persistence_probe').out).toBe('psa_edge/psa_edge_owner');
    // The other client's database has no such table.
    const other = pkgs[1]!;
    const otherQ = sh(`cd ${other.dir} && docker compose -f compose.yaml exec -T edge-postgres sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_owner_password)" psql -h 127.0.0.1 -U psa_edge_owner -d psa_edge -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()"'`);
    expect(otherQ.out, otherQ.err).toBe('0');
  }, 400_000);
});
