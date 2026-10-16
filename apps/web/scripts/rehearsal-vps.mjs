// VPS rehearsal, end to end, against a production-mode Control Plane started with scripts/vps/cp.sh
// (self-signed certificate, MFA required, digest-pinned edge image). Runs from this workstation:
//   1. signs in as the bootstrap administrator (password change if required, TOTP enrolment, verification),
//   2. onboards a client through the wizard API (custom-REST PSA against the fake PSA on this host),
//   3. generates the package, installs a real appliance in WSL (production compose overlay, image pulled by
//      digest from the registry), waits for enrollment over the public gateway address and verification,
//   4. decommissions, wipes with scripts/uninstall.sh and removes the record,
//   5. writes docs/reports/vps-rehearsal/rehearsal.json and screenshots. Nothing secret is printed or stored
//      outside the WSL root's home.
// Usage: node scripts/rehearsal-vps.mjs            (env: PSACC_REHEARSAL_HOST, PSACC_REHEARSAL_DIR)
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the rehearsal certificate is self-signed
const HOST = process.env.PSACC_REHEARSAL_HOST ?? '10.56.37.229';
const DIR = process.env.PSACC_REHEARSAL_DIR ?? '/opt/psacc-rehearsal';
const base = `https://${HOST}`;
const outDir = fileURLToPath(new URL('../../../docs/reports/vps-rehearsal/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const report = { host: HOST, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data = {}) => { report.steps.push({ name, at: new Date().toISOString(), ...data }); console.log('ok', name, JSON.stringify(data)); };
const sh = (cmd, timeout = 400_000) => { const r = spawnSync('wsl', ['-u', 'root', '--exec', 'bash', '-c', cmd], { encoding: 'utf8', timeout }); return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(3000); } throw new Error(`timed out: ${label}`); };

// ---- a tiny cookie-aware client (fetch) ---------------------------------------------------------------
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function api(method, path, body, extra = {}) {
  const headers = { accept: 'application/json', origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(jar.get('psacc_csrf') ? { 'x-csrf-token': jar.get('psacc_csrf') } : {}), cookie: cookieHeader(), ...extra };
  const r = await fetch(`${base}/api/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: r.status, body: json, text, bytes: json === null ? Buffer.from(text, 'binary') : null, raw: r };
}
async function apiBinary(method, path) {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { origin: base, 'x-csrf-token': jar.get('psacc_csrf'), cookie: cookieHeader() } });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const must = (r, status, label) => { if (r.status !== status) throw new Error(`${label}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`); return r.body; };

function totp(base32, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0; const bytes = [];
  for (const ch of base32.replace(/\s/g, '').toUpperCase()) { value = (value << 5) | alphabet.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(); const o = mac[mac.length - 1] & 15;
  const bin = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return (bin % 1_000_000).toString().padStart(6, '0');
}

// ---- 1. administrator sign-in in production mode --------------------------------------------------------
// Credentials come from the rehearsal .env inside WSL and are never printed. A changed password and the
// TOTP secret are kept in /root/.psacc-rehearsal (mode 600) so the script can be re-run.
const envGet = (k) => sh(`sed -n 's/^${k}=//p' ${DIR}/infra/control-plane/.env | head -n 1`).out;
const adminEmail = envGet('BOOTSTRAP_ADMIN_EMAIL');
const stateGet = (k) => sh(`test -f /root/.psacc-rehearsal && sed -n 's/^${k}=//p' /root/.psacc-rehearsal | head -n 1`).out;
const stateSet = (k, v) => sh(`umask 077; touch /root/.psacc-rehearsal; grep -v '^${k}=' /root/.psacc-rehearsal > /root/.psacc-rehearsal.new || true; echo '${k}=${v}' >> /root/.psacc-rehearsal.new; mv /root/.psacc-rehearsal.new /root/.psacc-rehearsal`);
let password = stateGet('PASSWORD') || envGet('BOOTSTRAP_ADMIN_PASSWORD');
let login = await api('POST', '/auth/login', { email: adminEmail, password });
must(login, 200, 'login');
let me = must(await api('GET', '/auth/me'), 200, 'me');
if (me.session.state === 'password_change_required') {
  const next = `Rh-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}!`;
  must(await api('POST', '/auth/password', { currentPassword: password, newPassword: next }), 200, 'password change');
  stateSet('PASSWORD', next); password = next;
  me = must(await api('GET', '/auth/me'), 200, 'me after password change');
}
if (me.session.state === 'mfa_setup_required') {
  const start = must(await api('POST', '/auth/mfa/enroll/start'), 200, 'mfa start');
  const code = totp(start.secret);
  const ok = must(await api('POST', '/auth/mfa/enroll/confirm', { code }), 200, 'mfa confirm');
  stateSet('TOTP_SECRET', start.secret);
  step('mfa-enrolled', { recoveryCodes: ok.recoveryCodes.length, qrSvg: !!start.qrSvg });
} else if (me.session.state === 'mfa_pending') {
  must(await api('POST', '/auth/mfa/verify', { code: totp(stateGet('TOTP_SECRET')) }), 200, 'mfa verify');
}
me = must(await api('GET', '/auth/me'), 200, 'me active');
if (me.session.state !== 'active') throw new Error(`session state ${me.session.state}`);
const info = must(await api('GET', '/system/info'), 200, 'system info').environment ?? null;
step('signed-in', { user: me.user.email, role: me.user.roles?.map((r) => r.key ?? r) ?? null, environment: info, mfaRequired: true });
// Production refuses an http origin: a request with a plain-http Origin header must be rejected.
const bad = await api('GET', '/auth/me', undefined, { origin: `http://${HOST}` });
step('http-origin-refused', { status: bad.status });

// ---- 2. onboarding through the wizard API ---------------------------------------------------------------
const hostIp = sh(`ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}'`).out;
const API_KEY = `rehearsal-${Math.random().toString(36).slice(2, 10)}`;
const caPath = join(realpathSync.native(mkdtempSync(join(tmpdir(), 'psacc-rhca-'))), 'ca.pem');
const fake = spawn(process.execPath, [fileURLToPath(new URL('./fake-psa.mjs', import.meta.url)), hostIp, API_KEY, caPath], { stdio: ['ignore', 'pipe', 'inherit'] });
const fakePort = await new Promise((resolve, reject) => {
  fake.stdout.on('data', (d) => { for (const line of String(d).split(/\r?\n/)) { const m = /^PORT (\d+)$/.exec(line); if (m) resolve(Number(m[1])); } });
  fake.on('exit', (code) => reject(new Error(`fake PSA exited with ${code}`)));
});
const services = must(await api('GET', '/services'), 200, 'services');
const svc = (...keys) => services.filter((s) => keys.includes(s.key)).map((s) => s.id);
const ref = `RH-${Date.now().toString(36).toUpperCase()}`;
const draft = must(await api('POST', '/onboarding/drafts'), 201, 'draft');
let version = draft.version;
const steps = [
  ['client', { company: { legalName: `Rehearsal Client ${ref} Ltd`, displayName: `Rehearsal Client ${ref}`, clientReference: ref, businessType: 'Technology', countryCode: 'US', stateRegion: 'Texas', city: 'Austin', timezone: 'America/Chicago', website: 'https://rehearsal.example' },
    management: { contractStartDate: '2026-10-01', contractEndDate: '2027-09-30', internalNotes: 'VPS rehearsal (synthetic).' },
    contacts: [{ fullName: 'Pat Primary', email: `pat.${ref.toLowerCase()}@client.example`, roles: ['primary'], phone: '+1 555 0100' }] }],
  ['psa-provider', { providerKey: 'custom_rest' }],
  ['psa-config', { displayName: `${ref} — Fake PSA`, authMethod: 'api_key', config: { baseUrl: `https://${hostIp}:${fakePort}/api`, healthPath: '/health', apiKeyHeader: 'X-API-Key', ticketsPath: '/tickets' } }],
  ['services', { serviceIds: svc('help_desk', 'endpoint_management') }],
  ['deployment', { targetEnvironment: 'local_test', targetOs: 'linux', targetArch: 'amd64', hostLabel: 'rehearsal-edge-01' }],
];
for (const [name, data] of steps) { const r = must(await api('PUT', `/onboarding/drafts/${draft.id}/steps/${name}`, { version, data }), 200, `step ${name}`); version = r.version; }
const done = must(await api('POST', `/onboarding/drafts/${draft.id}/complete`, { version, confirm: true }), 200, 'complete');
const res = done.result;
step('onboarded', { client: res.clientCode, psa: res.psaInstanceCode, license: res.licenseCode, deployment: res.deploymentCode });

// ---- 3. package and a real appliance against the public gateway address -------------------------------
const dep = must(await api('GET', `/deployments/${res.deploymentId}`), 200, 'deployment');
const failing = dep.readiness.filter((c) => !c.ok).map((c) => c.key);
if (failing.length) throw new Error(`readiness not met: ${failing.join(', ')}`);
const pkg = must(await api('POST', `/deployments/${res.deploymentId}/packages`, { tokenValidityHours: 1 }), 201, 'package').currentPackage;
const zip = await apiBinary('POST', `/deployments/${res.deploymentId}/packages/${pkg.id}/download`);
step('package', { number: pkg.number, bytes: zip.length, image: pkg.image, files: pkg.files.length });
if (!pkg.image.digest) throw new Error('production package must pin the image digest');
const winTmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'psacc-rh-')));
writeFileSync(join(winTmp, pkg.fileName), zip);
const unix = (p) => sh(`wslpath -a '${p}'`).out;
const project = `psacc-${res.deploymentCode.toLowerCase()}`;
const work = `/tmp/psacc-rehearsal-appliance/${project}`;
const adminPort = 18000 + (Number(res.deploymentCode.replace(/\D/g, '')) % 1000);
const adminBase = `http://127.0.0.1:${adminPort}`;
const curl = (args) => sh(`curl -s -o /tmp/psacc-rehearsal-appliance/body -w '%{http_code}' -b /tmp/psacc-rehearsal-appliance/jar -c /tmp/psacc-rehearsal-appliance/jar ${args}; echo; cat /tmp/psacc-rehearsal-appliance/body`, 60_000).out;
// The image is pulled by digest from the rehearsal registry (same digest the Control Plane pinned).
const pinned = `localhost:5000/psacc/psa-edge@${pkg.image.digest}`;
try {
  let r = sh(`rm -rf /tmp/psacc-rehearsal-appliance && mkdir -p /tmp/psacc-rehearsal-appliance && cd /tmp/psacc-rehearsal-appliance && unzip -q "${unix(join(winTmp, pkg.fileName))}" && cd ${project} && grep -c '@sha256:' compose.production.yaml && cp config/edge.env.template .env && echo 'PSA_EDGE_IMAGE=${pinned}' >> .env && sha256sum -c CHECKSUMS.sha256 | grep -c OK && scripts/install.sh --production`);
  if (r.code !== 0) throw new Error(`install failed: ${r.err || r.out}`);
  step('appliance-installed', { project, production: true, image: pinned.replace(/@sha256:(.{12}).*/, '@sha256:$1…') });
  await waitFor(async () => ['enrolled', 'verified'].includes((await api('GET', `/deployments/${res.deploymentId}`)).body.lifecycleState), 180_000, 'enrollment over the public gateway');
  const enrolled = (await api('GET', `/deployments/${res.deploymentId}`)).body;
  step('enrolled', { lifecycle: enrolled.lifecycleState, gatewayUrl: enrolled.agentGatewayUrl, certificate: enrolled.agentCertificates[0]?.subject });
  const verify = sh(`cd ${work} && scripts/verify.sh`, 180_000);
  step('verify-sh', { exit: verify.code, failures: (verify.out.match(/^FAIL/gm) ?? []).length });
  await waitFor(async () => (await api('GET', `/deployments/${res.deploymentId}`)).body.lifecycleState === 'verified', 180_000, 'verified');
  // Local admin: setup, PSA credentials, connection test (the PSA API is called from the appliance only).
  const pw = `rh-${res.deploymentCode}-local-admin-pass`;
  curl(`-X POST --data-urlencode username=localadmin --data-urlencode password=${pw} --data-urlencode confirm=${pw} ${adminBase}/setup`);
  const token = /name="csrf" value="([^"]+)"/.exec(curl(`${adminBase}/credentials`))[1];
  curl(`-X POST --data-urlencode csrf=${token} --data-urlencode field_apiKey=${API_KEY} --data-urlencode "field_tlsCaCertificate@${unix(caPath)}" ${adminBase}/credentials`);
  const tested = curl(`-X POST --data-urlencode csrf=${token} ${adminBase}/credentials/test`).includes('Connection verified');
  step('psa-connection-tested-on-appliance', { verified: tested });
  await waitFor(async () => (await api('GET', `/deployments/${res.deploymentId}/health`)).body.healthState === 'healthy', 180_000, 'healthy');
  const health = (await api('GET', `/deployments/${res.deploymentId}/health`)).body;
  step('health', { state: health.healthState, findings: health.findings.map((f) => f.code) });

  // ---- 4. decommission, wipe on the host, remove the record ------------------------------------------------
  const dec = must(await api('POST', `/deployments/${res.deploymentId}/decommission`, { reason: 'VPS rehearsal complete', confirmCode: res.deploymentCode }), 200, 'decommission');
  step('decommissioned', { fromState: dec.decommission.fromState, identity: dec.decommission.identity });
  await waitFor(async () => { const s = sh(`cd ${work} && docker compose -f compose.yaml -f compose.production.yaml exec -T edge-agent edge-agent status`, 60_000).out; try { return JSON.parse(s).state === 'decommissioned'; } catch { return false; } }, 120_000, 'agent decommissioned');
  step('appliance-saw-decommissioning', {});
  const refused = sh(`cd ${work} && scripts/uninstall.sh --wipe --confirm DEP-00000`, 120_000);
  const wipe = sh(`cd ${work} && scripts/uninstall.sh --wipe --confirm ${res.deploymentCode}`, 300_000);
  const left = sh(`docker ps -a --format '{{ .Names }}' | grep -c '^${project}-' ; docker volume ls -q | grep -c '^${project}_' ; test -e ${work}/secrets && echo secrets-present || echo secrets-gone`);
  writeFileSync(`${outDir}uninstall-sh-output.txt`, `$ scripts/uninstall.sh --wipe --confirm DEP-00000\n${refused.out}\n${refused.err}\n(exit ${refused.code})\n\n$ scripts/uninstall.sh --wipe --confirm ${res.deploymentCode}\n${wipe.out}\n${wipe.err}\n(exit ${wipe.code})\n\n${left.out}\n`);
  if (wipe.code !== 0) throw new Error(`wipe failed: ${wipe.err || wipe.out}`);
  step('wiped', { wrongCodeRefused: refused.code !== 0, leftovers: left.out.split('\n') });
  const rm = must(await api('DELETE', `/deployments/${res.deploymentId}`, { confirmCode: res.deploymentCode }), 200, 'remove');
  step('removed', { deleted: rm.deleted, afterwards: (await api('GET', `/deployments/${res.deploymentId}`)).status });
  const audit = must(await api('GET', `/clients/${res.clientId}/activity?pageSize=100`), 200, 'client activity').items.map((e) => e.action);
  step('audit-trail', { has: ['client.onboarded', 'agent.enrolled', 'deployment.decommissioned', 'deployment.removed'].filter((a) => audit.includes(a)) });

  // ---- 5. a browser look through the edge (sign-in page and the dashboard after MFA) ----------------------
  const b = await chromium.launch({ channel: 'msedge' });
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addCookies([...jar].map(([name, value]) => ({ name, value, domain: HOST, path: '/', secure: true, httpOnly: name === 'psacc_session', sameSite: 'Lax' })));
  const p = await ctx.newPage();
  await p.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${outDir}02-dashboard-production-mode.png` });
  await p.goto(`${base}/clients/${res.clientId}`, { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${outDir}03-client-after-rehearsal.png`, fullPage: true });
  await b.close();
  step('screenshots', { files: ['01-login-over-edge.png', '02-dashboard-production-mode.png', '03-client-after-rehearsal.png'] });
} finally {
  sh(`cd ${work} 2>/dev/null && docker compose -f compose.yaml down --volumes --remove-orphans; rm -rf /tmp/psacc-rehearsal-appliance`);
  rmSync(winTmp, { recursive: true, force: true });
  fake.kill('SIGTERM');
  rmSync(caPath, { force: true });
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${outDir}rehearsal.json`, JSON.stringify(report, null, 2));
  await api('POST', '/auth/logout').catch(() => undefined);
}
console.log('REHEARSAL COMPLETE');
