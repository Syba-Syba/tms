import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { createLogger, type Logger } from './logger';

type Req = { method: string; url: string; headers: Record<string, unknown>; log?: Logger };
type Res = { statusCode: number; setHeader: (k: string, v: string) => void; json: (b: unknown) => void; on: (e: string, cb: () => void) => void };
type Next = (error?: unknown) => void;

/** Attaches a correlation id and a request scoped logger, then logs the outcome. */
export function requestLogger(base = createLogger()) {
  return (req: Req, res: Res, next: Next) => {
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    res.setHeader('x-request-id', requestId);
    req.log = base.child({ requestId, method: req.method, path: req.url });
    const started = Date.now();
    res.on('finish', () =>
      req.log?.info('Request completed.', { status: res.statusCode, durationMs: Date.now() - started }),
    );
    next();
  };
}

export function errorHandler() {
  return (error: unknown, req: Req, res: Res, _next: Next) => {
    const known = error instanceof AppError;
    const status = known ? error.status : 500;
    req.log?.error('Request failed.', {
      status,
      code: known ? error.code : 'internal_error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.statusCode = status;
    res.json({
      error: {
        code: known ? error.code : 'internal_error',
        message: known ? error.message : 'Something went wrong on our side.',
        details: known ? error.details : undefined,
      },
    });
  };
}

/** Wraps an async handler so a rejected promise reaches the error handler instead of hanging. */
export const asyncRoute =
  (handler: (req: Req, res: Res, next: Next) => Promise<unknown>) =>
  (req: Req, res: Res, next: Next) =>
    handler(req, res, next).catch(next);
