#!/usr/bin/env node
// PSA Edge (Go) tooling through Docker — Go does not need to be installed locally.
//   node scripts/edge.mjs tidy    go mod tidy (updates go.mod / go.sum)
//   node scripts/edge.mjs test    go vet + go test with coverage summary
//   node scripts/edge.mjs build   docker build -t psacc/psa-edge:<version>
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { docker, dockerMode } from './lib/docker.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const edgeDir = join(root, 'apps', 'edge');
const GO_IMAGE = 'golang:1.25-alpine';
const version = process.env.EDGE_VERSION ?? JSON.parse(readFileSync(join(root, 'apps', 'api', 'package.json'), 'utf8')).version;
const repo = process.env.EDGE_IMAGE_REPOSITORY ?? 'psacc/psa-edge';
// Module 16: the image pins the Control Plane's license verification key, derived from apps/api/.env.
function licensePublicKey() {
  try {
    const env = readFileSync(join(root, 'apps', 'api', '.env'), 'utf8');
    const seed = /^LICENSE_SIGNING_KEY=(\S+)/m.exec(env)?.[1];
    if (!seed) return '';
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64')]);
    return createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).toString('base64');
  } catch {
    return '';
  }
}

/** Path of apps/edge as the Docker daemon sees it (WSL mounts Windows drives under /mnt). */
function daemonPath(p) {
  if (dockerMode() !== 'wsl') return p;
  return p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
}

function goRun(script) {
  return docker(['run', '--rm', '-v', `${daemonPath(edgeDir)}:/src`, '-v', 'psacc-gomod:/go/pkg/mod', '-w', '/src', '-e', 'CGO_ENABLED=0', GO_IMAGE, 'sh', '-c', script]);
}

const cmd = process.argv[2];
let r;
switch (cmd) {
  case 'tidy':
    r = goRun('go mod tidy && go mod verify');
    break;
  case 'test':
    r = goRun('go vet ./... && go test -count=1 -cover ./...');
    break;
  case 'build':
    if (!licensePublicKey()) console.warn('warning: apps/api/.env has no LICENSE_SIGNING_KEY — the image carries no pinned license key (run pnpm setup).');
    r = docker(['build', '-t', `${repo}:${version}`, '--build-arg', `VERSION=${version}`, '--build-arg', `LICENSE_PUBLIC_KEY=${licensePublicKey()}`, daemonPath(edgeDir)]);
    if (r.status === 0) docker(['image', 'inspect', `${repo}:${version}`, '--format', '{{.Id}} {{.Size}} bytes, user {{.Config.User}}']);
    break;
  case 'export': {
    // Air-gapped clients: an OCI archive to copy with the package and load with `docker load -i`
    // (docs/RUNBOOKS.md). The checksum file travels with it; the package's verify script checks the
    // loaded image's ID against the one recorded here.
    const outDir = join(root, 'dist', 'edge');
    const name = `psa-edge-${version}.tar`;
    const dir = daemonPath(outDir);
    const script = `mkdir -p '${dir}' && docker save -o '${dir}/${name}' ${repo}:${version} && cd '${dir}' && sha256sum '${name}' > '${name}.sha256' && docker image inspect ${repo}:${version} --format '{{.Id}}' > '${name}.image-id' && ls -l '${name}' && cat '${name}.sha256' '${name}.image-id'`;
    r = spawnSync(process.platform === 'win32' ? 'wsl' : 'bash', process.platform === 'win32' ? ['--exec', 'bash', '-c', script] : ['-c', script], { stdio: 'inherit' });
    if (r.status === 0) console.log(`exported to dist/edge/${name} (+ .sha256, .image-id)`);
    break;
  }
  default:
    console.error('usage: node scripts/edge.mjs <tidy|test|build|export>');
    process.exit(2);
}
process.exit(r.status ?? 1);
