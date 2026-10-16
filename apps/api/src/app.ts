import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import helmet from 'helmet';
import type pg from 'pg';
import { AppModule } from './app.module.js';
import type { AppRequest } from './common/auth-context.js';
import { JsonLogger } from './common/logger.js';
import type { AppConfig } from './config/env.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Builds a fully configured (not yet listening) application. Shared by main.ts and tests. */
export async function createApp(config: AppConfig, opts: { logger?: JsonLogger; pool?: pg.Pool } = {}): Promise<NestExpressApplication> {
  const logger = opts.logger ?? new JsonLogger(config.logLevel);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, logger, opts.pool), {
    logger,
    bodyParser: false,
  });

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '100kb' });
  app.use(cookieParser());
  const hsts = config.auth.secureCookies ? { maxAge: 31_536_000, includeSubDomains: true } : false;
  // JSON API: nothing may render or frame it. The OpenAPI UI (dev only) needs its own assets.
  const strictHeaders = helmet({
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts,
  });
  const docsHeaders = helmet({
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] },
    },
    hsts,
  });
  app.use((req: AppRequest, res: Response, next: NextFunction) =>
    (req.path.startsWith('/api/docs') ? docsHeaders : strictHeaders)(req, res, next),
  );

  // Request ID (accepts a well-formed inbound x-request-id from our own proxy) + access log.
  app.use((req: AppRequest, res: Response, next: NextFunction) => {
    const inbound = req.headers['x-request-id'];
    req.requestId = typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    const started = performance.now();
    res.on('finish', () => {
      logger.event(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'http.request', {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        userId: req.auth?.userId,
        ip: req.ip,
      });
    });
    next();
  });

  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  if (config.openApiEnabled) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('PSA Control Center API')
        .setDescription(
          'Control Plane user API. Authentication: opaque session cookie. Unsafe methods require the `x-csrf-token` header ' +
            '(value of the CSRF cookie). Errors use RFC 9457 problem+json.',
        )
        .setVersion(config.version)
        .addCookieAuth(config.auth.sessionCookieName, { type: 'apiKey', in: 'cookie' }, 'session')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
  return app;
}
