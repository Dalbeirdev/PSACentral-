import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildPackage, EDGE_REQUIRED_TABLES, localAdminPort, oneLine, type PackageInput, render } from '../../src/modules/deployments/package-builder.js';

const TOKEN = 'psacc_enr_UNITTESTTOKEN0123456789abcdefghijklmnopqrstu';
const input = (over: Partial<PackageInput> = {}): PackageInput => ({
  deployment: { id: '11111111-1111-4111-8111-111111111111', code: 'DEP-00042', targetEnvironment: 'linux_docker', targetEnvironmentLabel: 'Linux Docker host', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'edge-01' },
  license: { id: '55555555-5555-4555-8555-555555555555', code: 'LIC-00007', displayName: 'Help Desk Standard', endsAt: '2027-06-30' },
  client: { id: '22222222-2222-4222-8222-222222222222', code: 'CL-00027', displayName: 'Test Client A' },
  psa: {
    instanceId: '33333333-3333-4333-8333-333333333333', code: 'PSA-00030', displayName: 'Test Client A — Autotask', providerKey: 'autotask', providerName: 'Autotask PSA',
    authMethod: 'api_user', apiEndpoint: 'https://webservices5.autotask.net/ATServicesRest', config: { zone: 'webservices5' },
    credentialFields: [{ key: 'username', label: 'API user name', secret: false }, { key: 'secret', label: 'API secret', secret: true }],
  },
  services: [{ key: 'help_desk', name: 'Help Desk', usesPsa: true, settings: { defaultPriority: 'medium' } }, { key: 'endpoint_management', name: 'Endpoint Management', usesPsa: false, settings: {} }],
  packageNumber: 2,
  installationId: '44444444-4444-4444-8444-444444444444',
  generatedAt: new Date('2026-10-14T12:00:00Z'),
  generatedBy: 'Jordan Ellis',
  image: { repository: 'psacc/psa-edge', version: '0.1.0', digest: null },
  agentGatewayUrl: 'https://gateway.example.test',
  ca: { pem: '-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----\n', fingerprint: 'ab'.repeat(32) },
  heartbeatSeconds: 60,
  token: TOKEN,
  tokenExpiresAt: new Date('2026-10-15T12:00:00Z'),
  ...over,
});

function unpack(archive: Buffer) {
  const files = unzipSync(new Uint8Array(archive));
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('template rendering', () => {
  it('fills {{name}} placeholders, leaves Go templates alone and refuses unknown variables', () => {
    expect(render('a {{x}} b {{.ExitCode}}', { x: 1 })).toBe('a 1 b {{.ExitCode}}');
    expect(() => render('{{missing}}', {})).toThrow(/missing/);
  });

  it('flattens text so names cannot break out of comments or table cells', () => {
    expect(oneLine('Acme\nservices:\n  evil: {}| x')).toBe('Acme services:   evil: {}/ x');
  });

  it('gives each deployment a stable local admin port', () => {
    expect(localAdminPort('DEP-00042')).toBe(18042);
    expect(localAdminPort('DEP-01042')).toBe(18042);
  });
});

describe('deployment package', () => {
  const built = buildPackage(input());
  const files = unpack(built.archive);
  const root = 'psacc-dep-00042/';
  const text = (p: string) => files[root + p]!.toString('utf8');

  it('contains every required file under one folder, with matching manifest, checksums and SHA-256', () => {
    expect(Object.keys(files).sort()).toEqual([
      'CHECKSUMS.sha256', 'INSTALL.md', 'README.md', 'UNINSTALL.md', 'compose.production.yaml', 'compose.yaml', 'config/edge.env.template',
      'config/edge.json', 'enrollment/enrollment.json', 'manifest.json', 'scripts/edge-backup.sh', 'scripts/install.ps1', 'scripts/install.sh', 'scripts/uninstall.ps1', 'scripts/uninstall.sh', 'scripts/upgrade.ps1', 'scripts/upgrade.sh', 'scripts/verify.ps1', 'scripts/verify.sh',
    ].map((p) => root + p).sort());
    expect(built.fileName).toBe('psacc-dep-00042-package-2.zip');
    expect(built.sha256).toBe(sha(built.archive));
    expect(built.sizeBytes).toBe(built.archive.length);
    for (const f of built.files) expect(sha(files[root + f.path]!), f.path).toBe(f.sha256);
    for (const line of text('CHECKSUMS.sha256').trim().split('\n')) {
      const [digest, path] = line.split('  ');
      expect(sha(files[root + path!]!), path).toBe(digest);
    }
    const manifest = JSON.parse(text('manifest.json'));
    expect(manifest.files.map((f: { path: string }) => f.path)).not.toContain('manifest.json');
    expect(manifest.installationId).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('leaves no unrendered placeholder in any file', () => {
    for (const [name, data] of Object.entries(files)) expect(data.toString('utf8'), name).not.toMatch(/\{\{[A-Za-z]/);
  });

  it('puts the single-use token in enrollment/enrollment.json only, and no permanent secret anywhere', () => {
    const enrollment = JSON.parse(text('enrollment/enrollment.json'));
    expect(enrollment).toMatchObject({ token: TOKEN, caFingerprint: 'ab'.repeat(32), caCertificate: expect.stringContaining('BEGIN CERTIFICATE'), deploymentCode: 'DEP-00042', installationId: '44444444-4444-4444-8444-444444444444', expiresAt: '2026-10-15T12:00:00.000Z' });
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('enrollment/enrollment.json')) continue;
      expect(data.toString('utf8'), name).not.toContain(TOKEN);
      // Passwords are only ever read from the host's secret files at run time, never written as values.
      expect(data.toString('utf8'), name).not.toMatch(/PASSWORD=(?![`\"]*\$)\S|postgres:\/\/[^\s]*:[^\s]*@/);
    }
    expect(built.files.filter((f) => f.containsToken).map((f) => f.path)).toEqual(['enrollment/enrollment.json']);
  });

  it('writes the non-secret appliance configuration with the PSA settings, services and allowed reports', () => {
    const cfg = JSON.parse(text('config/edge.json'));
    expect(cfg).toMatchObject({
      schemaVersion: 1,
      deployment: { code: 'DEP-00042', packageNumber: 2 },
      psa: { provider: 'autotask', apiEndpoint: 'https://webservices5.autotask.net/ATServicesRest', config: { zone: 'webservices5' } },
      controlPlane: { agentGatewayUrl: 'https://gateway.example.test', heartbeatIntervalSeconds: 60 },
    });
    expect(cfg.psa.credentialFields.map((f: { key: string }) => f.key)).toEqual(['username', 'secret']);
    expect(JSON.stringify(cfg)).not.toMatch(/"value"|password"\s*:/i);
    expect(cfg.controlPlane.reports).toContain('ticket_processing_metrics');
    expect(cfg).toEqual(built.config);
  });

  it('isolates the Compose project, keeps the database off the network and binds the admin UI to loopback', () => {
    const compose = text('compose.yaml');
    expect(compose).toContain('name: psacc-dep-00042');
    expect(compose).toContain('"127.0.0.1:${EDGE_LOCAL_ADMIN_PORT:-18042}:8480"');
    const postgres = compose.slice(compose.indexOf('  edge-postgres:'), compose.indexOf('  edge-migrate:'));
    expect(postgres).not.toMatch(/ports:/);
    expect(compose).toMatch(/edge-internal:\n\s+internal: true/);
    expect(compose).toContain('file: ./secrets/data_key');
    for (const v of ['pgdata', 'edge-logs', 'edge-backups', 'agent-state']) expect(compose).toContain(`  ${v}: {}`);
    const backup = compose.slice(compose.indexOf('  edge-backup:'), compose.indexOf('\nnetworks:'));
    expect(backup).toContain('read_only: true');
    expect(backup).not.toMatch(/ports:/);
    expect(compose).toContain('"${PSA_EDGE_IMAGE:-psacc/psa-edge:0.1.0}"');
  });

  it('production overrides require a pinned image until a signed digest is published, then default to it', () => {
    expect(text('compose.production.yaml')).toContain('${PSA_EDGE_IMAGE:?Set PSA_EDGE_IMAGE to the signed PSA Edge image pinned by digest');
    const digest = `sha256:${'a'.repeat(64)}`;
    const pinned = unpack(buildPackage(input({ image: { repository: 'psacc/psa-edge', version: '0.1.0', digest } })).archive);
    expect(pinned[`${root}compose.production.yaml`]!.toString()).toContain(`"\${PSA_EDGE_IMAGE:-psacc/psa-edge:0.1.0@${digest}}"`);
  });

  it('uses LF and exec bits for shell scripts, CRLF and a BOM for PowerShell, 0600 for the token file', () => {
    const sh = files[`${root}scripts/install.sh`]!;
    expect(sh.toString().startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(sh.includes('\r\n')).toBe(false);
    const ps = files[`${root}scripts/install.ps1`]!;
    expect([...ps.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(ps.toString().includes('\r\n')).toBe(true);
    // Unix mode is stored in the high 16 bits of each central-directory entry's external attributes.
    const modes: Record<string, number> = {};
    const a = built.archive;
    for (let o = a.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); o >= 0; o = a.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), o + 4)) {
      const nameLen = a.readUInt16LE(o + 28);
      modes[a.subarray(o + 46, o + 46 + nameLen).toString()] = (a.readUInt32LE(o + 38) >>> 16) & 0o777;
    }
    expect(modes[`${root}scripts/install.sh`]).toBe(0o755);
    expect(modes[`${root}scripts/verify.sh`]).toBe(0o755);
    expect(modes[`${root}enrollment/enrollment.json`]).toBe(0o600);
    expect(modes[`${root}compose.yaml`]).toBe(0o644);
  });

  it('the verify script checks for every required edge table', () => {
    expect(text('scripts/verify.sh')).toContain(`-ge ${EDGE_REQUIRED_TABLES.length} ]`);
    expect(text('scripts/verify.sh')).toContain("{{.ExitCode}}");
    // Module 13: the host-side upgrade script applies a staged, signed order and keeps Docker format strings intact.
    expect(text('scripts/upgrade.sh')).toContain('upgrade-order.json');
    expect(text('scripts/upgrade.sh')).toContain('{{ .RepoDigests }}');
    expect(text('scripts/upgrade.sh')).toContain('EXPECTED_REPO="psacc/psa-edge:');
    // Module 15: the removal scripts carry the deployment ID as the typed confirmation and refuse to wipe an active identity.
    expect(text('scripts/uninstall.sh')).toContain('--confirm DEP-00042');
    expect(text('scripts/uninstall.sh')).toContain('"$STATE" != "decommissioned"');
    expect(text('scripts/uninstall.sh')).toContain('{{ .Service }}');
    expect(text('scripts/uninstall.ps1')).toContain("-Confirm DEP-00042");
    expect(text('UNINSTALL.md')).toContain('Control Plane first');
  });

  it('documents what the package is (not an image), the token expiry and the credential fields', () => {
    expect(text('README.md')).toContain('**It is not a Docker image.**');
    expect(text('INSTALL.md')).toContain('2026-10-15T12:00:00.000Z');
    expect(text('INSTALL.md')).toContain('- API secret (secret)');
    expect(text('UNINSTALL.md')).toContain('scripts/uninstall.sh --wipe --confirm DEP-00042');
    expect(strFromU8(new Uint8Array(files[`${root}README.md`]!))).toContain('Help Desk, Endpoint Management');
  });
});
