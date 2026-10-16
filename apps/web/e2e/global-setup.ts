import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { e2eApiEnv } from './env';

/** Rebuilds the isolated psacc_e2e database: drop → migrate → synthetic seed. */
export default async function globalSetup() {
  const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
  execSync('pnpm exec tsx src/database/cli.ts reset', {
    cwd: apiDir,
    env: { ...process.env, ...e2eApiEnv() },
    stdio: 'inherit',
  });
}
