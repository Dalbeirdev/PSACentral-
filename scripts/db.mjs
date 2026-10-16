#!/usr/bin/env node
// Local development database helper.  Usage: node scripts/db.mjs <up|down|status|psql|logs>
// `down` stops the container but NEVER removes the data volume.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, dockerMode } from './lib/docker.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const devDir = join(root, 'infra', 'dev');
const cmd = process.argv[2] ?? 'status';

if (!existsSync(join(devDir, '.env'))) {
  console.error('infra/dev/.env is missing. Run `pnpm setup` first.');
  process.exit(1);
}

const compose = (...args) => docker(['compose', ...args], { cwd: devDir });
let result;
switch (cmd) {
  case 'up':
    console.log(`Starting psacc-dev PostgreSQL (docker: ${dockerMode()})…`);
    result = compose('up', '-d', '--wait');
    break;
  case 'down':
    result = compose('stop');
    break;
  case 'status':
    result = compose('ps');
    break;
  case 'logs':
    result = compose('logs', '--tail', '100', 'postgres');
    break;
  case 'psql':
    result = docker(['exec', '-it', 'psacc-dev-postgres', 'psql', '-U', 'postgres', '-d', process.argv[3] ?? 'psacc_dev']);
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    process.exit(2);
}
process.exit(result?.status ?? 1);
