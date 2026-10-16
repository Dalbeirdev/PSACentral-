import { describe, expect, it } from 'vitest';
import { JsonLogger } from '../../src/common/logger.js';
import type { AppConfig } from '../../src/config/env.js';
import { createPool } from '../../src/database/database.service.js';

// Nothing connects here: the pool only opens connections on the first checkout.
const config = { database: { url: 'postgres://psacc_app:unused@127.0.0.1:1/psacc', poolMax: 1, statementTimeoutMs: 1_000 } } as unknown as AppConfig;

describe('database pool', () => {
  it('survives a server-side connection termination (logged, not fatal)', async () => {
    const lines: string[] = [];
    const logger = new JsonLogger('debug', (l) => lines.push(l));
    const pool = createPool(config, logger);
    try {
      // What `pg` emits when PostgreSQL restarts or an idle connection is terminated:
      // without a listener Node raises it as an unhandled 'error' event and the API process exits.
      expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(entry.level).toBe('warn');
      expect(entry.context).toBe('DatabaseService');
      expect(entry.error).toBe('terminating connection due to administrator command');
      expect(JSON.stringify(entry)).not.toContain('unused'); // the connection string's password is never logged
    } finally {
      await pool.end();
    }
  });
});
