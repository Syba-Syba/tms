type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT = ['password', 'token', 'authorization', 'idNumber', 'accountNumber'];

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        REDACT.some((f) => key.toLowerCase().includes(f.toLowerCase())) ? '[redacted]' : redact(val),
      ]),
    );
  }
  return value;
};

/** Structured JSON logs so CloudWatch and Log Analytics can query them. */
export function createLogger(context: Record<string, unknown> = {}, level: Level = 'info') {
  const write = (lvl: Level, message: string, extra?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const line = JSON.stringify({
      level: lvl,
      time: new Date().toISOString(),
      message,
      ...(redact(context) as object),
      ...(redact(extra ?? {}) as object),
    });
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m: string, e?: Record<string, unknown>) => write('debug', m, e),
    info: (m: string, e?: Record<string, unknown>) => write('info', m, e),
    warn: (m: string, e?: Record<string, unknown>) => write('warn', m, e),
    error: (m: string, e?: Record<string, unknown>) => write('error', m, e),
    child: (extra: Record<string, unknown>) => createLogger({ ...context, ...extra }, level),
  };
}

export type Logger = ReturnType<typeof createLogger>;
