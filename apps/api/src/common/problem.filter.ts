import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ProblemDetails } from '@psacc/contracts';
import type { Response } from 'express';
import type { AppRequest } from './auth-context.js';
import type { JsonLogger } from './logger.js';
import { ValidationFailedException } from './zod.js';

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  422: 'Unprocessable request',
  429: 'Too many requests',
  500: 'Internal server error',
};

/** Domain error carrying a stable problem type and a user-safe message. */
export class AppError extends HttpException {
  constructor(status: number, public readonly problemType: string, message: string) {
    super(message, status);
  }
}

/** Converts every error into RFC 9457 problem+json. Never leaks stack traces or SQL. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AppRequest>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let type = 'about:blank';
    let detail: string | undefined;
    let errors: ProblemDetails['errors'];

    if (exception instanceof ValidationFailedException) {
      status = 400;
      type = 'urn:psacc:problem:validation';
      detail = 'One or more fields are invalid.';
      errors = exception.issues;
    } else if (exception instanceof AppError) {
      status = exception.getStatus();
      type = `urn:psacc:problem:${exception.problemType}`;
      detail = exception.message;
    } else if (exception instanceof ThrottlerException) {
      status = 429;
      type = 'urn:psacc:problem:rate-limited';
      detail = 'Too many requests. Wait a moment and try again.';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      detail = typeof body === 'string' ? body : typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : undefined;
    } else if (isPgError(exception) && exception.code === '23505') {
      status = 409;
      type = 'urn:psacc:problem:duplicate';
      detail = 'A record with the same unique value already exists.';
    } else if (isPgError(exception) && exception.code === '23514') {
      status = 422;
      type = 'urn:psacc:problem:constraint';
      detail = 'The request violates a data integrity rule.';
    }

    if (status >= 500) {
      this.logger.event('error', 'request.failed', {
        requestId: req?.requestId,
        method: req?.method,
        path: req?.path,
        error: exception instanceof Error ? { name: exception.name, message: exception.message, stack: exception.stack } : String(exception),
      });
      detail = 'An unexpected error occurred. Quote the request ID when reporting this problem.';
    }

    const problem: ProblemDetails = {
      type,
      title: TITLES[status] ?? 'Error',
      status,
      ...(detail ? { detail } : {}),
      requestId: req?.requestId,
      ...(errors ? { errors } : {}),
    };
    res.status(status).type('application/problem+json').json(problem);
  }
}

function isPgError(e: unknown): e is { code: string } {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' && 'severity' in e;
}
