/**
 * Structured logging for the API.
 *
 * One Lambda serves all forty-eight routes into one log group, which is the whole point of the
 * single-function shape, but it also means a bare `console.log` line cannot be tied back to the
 * request that produced it. Every line here carries the API Gateway request id, the caller and
 * the route, so a CloudWatch Insights filter on requestId returns one request's whole story.
 *
 * Fields whose names look like a secret or like PoPIA material are redacted. `console.error`
 * on a raw error object was writing whole request bodies into the log group, and this API
 * handles ID numbers, payslips and bank details.
 *
 * This deliberately does not import @hlonie/toolbox/node, which has an equivalent logger. The
 * API has no toolbox dependency at all, and serverless.yml zips node_modules with no bundler,
 * so a symlinked workspace package would not reliably reach the Lambda. Consolidating the two
 * needs esbuild in the deploy step first; see TECH_DEBT.md.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL = (process.env.LOG_LEVEL as Level) ?? 'info';

/** Substring match, so idNumber, id_number and idNumberEnc are all caught. */
const SECRET_KEYS = [
  'password',
  'token',
  'authorization',
  'secret',
  'idnumber',
  'id_number',
  'accountnumber',
  'account_number',
  'signature',
  'signaturebase64',
];

const looksSecret = (key: string) => {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((needle) => lower.includes(needle));
};

const redact = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        looksSecret(key) ? '[redacted]' : redact(val, depth + 1),
      ]),
    );
  }
  return value;
};

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): Logger;
}

export function createLogger(context: Record<string, unknown> = {}): Logger {
  const write = (level: Level, message: string, extra?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[MIN_LEVEL]) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      message,
      ...(redact(context) as object),
      ...(redact(extra ?? {}) as object),
    });
    // Both streams reach the same CloudWatch log group; the split keeps errors visible when a
    // local terminal is filtering stdout.
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (message, extra) => write('debug', message, extra),
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}

/** The fallback for code with no request to hang off: module scope and the scheduled jobs. */
export const logger = createLogger();

/** A logger for one scheduled invocation, so a run's lines group together. */
export const jobLogger = (job: string) => createLogger({ job });
