import type { LoggerService } from '@nestjs/common';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|private|otp|recovery|credential|hash/i;
const MAX_DEPTH = 6;

/** Recursively replaces values under sensitive-looking keys. Exported for tests. */
export function maskSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : maskSecrets(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Mask connection strings and bearer tokens that slip into messages.
    return value
      .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[REDACTED]@')
      .replace(/(bearer\s+)[a-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
  }
  return value;
}

/** Structured JSON logger (one line per event) with secret masking. */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly minLevel: Level = 'info',
    private readonly sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
  ) {}

  private write(level: Level, message: unknown, context?: string, extra?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      context,
      msg: typeof message === 'string' ? maskSecrets(message) : undefined,
      ...(typeof message === 'object' && message !== null ? (maskSecrets(message) as object) : {}),
      ...(extra ? (maskSecrets(extra) as object) : {}),
    };
    this.sink(JSON.stringify(entry));
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, stackOrContext?: string, context?: string) {
    const ctx = context ?? (stackOrContext && !stackOrContext.includes('\n') ? stackOrContext : undefined);
    const stack = stackOrContext && stackOrContext.includes('\n') ? stackOrContext : undefined;
    this.write('error', message, ctx, stack ? { stack } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  event(level: Level, msg: string, fields: Record<string, unknown>) {
    this.write(level, msg, undefined, fields);
  }
}
