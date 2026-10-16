// Database CLI:  tsx src/database/cli.ts <migrate|status|seed [--reset]|reset>
//   reset = drop + migrate + seed; allowed only for *_test / *_e2e databases with APP_ENV=test.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { bootstrap } from './bootstrap.js';
import { migrate, migrationStatus } from './migrator.js';
import { seed } from './seed.js';

const [, , command, ...flags] = process.argv;
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
if (!ownerUrl) {
  console.error('MIGRATION_DATABASE_URL is not set (schema owner connection). Run `pnpm setup`.');
  process.exit(78);
}

try {
  switch (command) {
    case 'migrate': {
      const r = await migrate(ownerUrl);
      console.log(r.applied.length ? `Applied ${r.applied.length} migration(s).` : `Schema is current (${r.alreadyApplied} applied).`);
      break;
    }
    case 'status': {
      const client = new pg.Client({ connectionString: ownerUrl });
      await client.connect();
      for (const m of await migrationStatus(client)) {
        console.log(`${m.version}  ${m.state.padEnd(18)} ${m.name}  ${m.appliedAt?.toISOString() ?? ''}`);
      }
      await client.end();
      break;
    }
    case 'reset': {
      // Destructive: only for the isolated automated-test databases.
      const db = new URL(ownerUrl).pathname.slice(1);
      if (process.env.APP_ENV !== 'test' || !/_(test|e2e)$/.test(db)) {
        throw new Error(`Refusing to reset "${db}" (APP_ENV=${process.env.APP_ENV ?? 'unset'}). Only *_test / *_e2e databases with APP_ENV=test.`);
      }
      const password = process.env.SEED_DEFAULT_PASSWORD;
      if (!password) throw new Error('SEED_DEFAULT_PASSWORD is not set.');
      const client = new pg.Client({ connectionString: ownerUrl });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION psacc_owner;
        REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO psacc_app_rw;`);
      await client.end();
      await migrate(ownerUrl, () => undefined);
      await seed(ownerUrl, { password });
      console.log(`Reset ${db}.`);
      break;
    }
    case 'seed': {
      const password = process.env.SEED_DEFAULT_PASSWORD;
      if (!password) throw new Error('SEED_DEFAULT_PASSWORD is not set.');
      await migrate(ownerUrl, () => undefined);
      await seed(ownerUrl, { password, reset: flags.includes('--reset') });
      break;
    }
    case 'bootstrap': {
      // First organization + Super Administrator for environments without synthetic data (containers,
      // staging, production). Values come from the environment; the password is read from
      // BOOTSTRAP_ADMIN_PASSWORD or the file named by BOOTSTRAP_ADMIN_PASSWORD_FILE and never printed.
      const e = process.env;
      const password = e.BOOTSTRAP_ADMIN_PASSWORD ?? (e.BOOTSTRAP_ADMIN_PASSWORD_FILE ? readFileSync(e.BOOTSTRAP_ADMIN_PASSWORD_FILE, 'utf8').trim() : '');
      if (!e.BOOTSTRAP_ADMIN_EMAIL || !password) throw new Error('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (or _FILE) are required.');
      await migrate(ownerUrl, () => undefined);
      const r = await bootstrap(ownerUrl, {
        orgName: e.BOOTSTRAP_ORG_NAME ?? 'PSA Control Center', orgSlug: e.BOOTSTRAP_ORG_SLUG ?? 'control-plane',
        adminEmail: e.BOOTSTRAP_ADMIN_EMAIL, adminName: e.BOOTSTRAP_ADMIN_NAME ?? 'Platform Administrator', password,
      });
      console.log(r.status === 'created' ? `Bootstrapped organization "${e.BOOTSTRAP_ORG_SLUG ?? 'control-plane'}" with administrator ${e.BOOTSTRAP_ADMIN_EMAIL}.` : 'Organization already bootstrapped — nothing changed.');
      break;
    }
    default:
      console.error('Usage: cli.ts <migrate|status|seed [--reset]|reset|bootstrap>');
      process.exit(2);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
