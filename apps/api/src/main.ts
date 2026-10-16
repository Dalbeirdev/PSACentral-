import { createApp } from './app.js';
import { JsonLogger } from './common/logger.js';
import { ConfigError, loadConfig } from './config/env.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
  const logger = new JsonLogger(config.logLevel);
  const app = await createApp(config, { logger });
  await app.listen(config.port, config.host);
  logger.event('info', 'api.started', {
    environment: config.env,
    version: config.version,
    url: `http://${config.host}:${config.port}/api/v1`,
    openApi: config.openApiEnabled ? `http://${config.host}:${config.port}/api/docs` : 'disabled',
    mfaRequired: config.auth.mfaRequired,
  });
}

void main();
