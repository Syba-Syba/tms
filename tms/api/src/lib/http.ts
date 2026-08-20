import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ZodError, type ZodSchema } from 'zod';
import { createLogger } from './logger';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);
export const forbidden = (message = 'Not allowed.') => new ApiError(403, 'forbidden', message);
export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);
export const tooManyRequests = (message: string) => new ApiError(429, 'rate_limited', message);

export const conflict = (message: string) => new ApiError(409, 'conflict', message);

export const json = (status: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function parseBody<T>(event: { body?: string }, schema: ZodSchema<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(event.body ?? '{}');
  } catch {
    throw badRequest('Body must be valid JSON.');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw badRequest('Some fields need fixing.', fieldErrors(result.error));
  }
  return result.data;
}

const fieldErrors = (error: ZodError) =>
  Object.fromEntries(error.issues.map((issue) => [issue.path.join('.'), issue.message]));

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

/**
 * A logger bound to one request. One function serves every route into one log group, so
 * without the request id a failure line cannot be tied to the call that produced it.
 */
export function requestLogger(event: Event) {
  const context = event.requestContext ?? ({} as Event['requestContext']);
  return createLogger({
    requestId: context.requestId,
    // Set by API Gateway and carried by the AWS SDK, so a log line joins up with an X-Ray trace.
    traceId: event.headers?.['x-amzn-trace-id'],
    method: context.http?.method,
    path: context.http?.path,
    userSub: context.authorizer?.jwt?.claims?.sub,
  });
}

/** Wraps a handler so every failure returns the same shape and nothing leaks a stack trace. */
export const route =
  (handler: (event: Event) => Promise<APIGatewayProxyResultV2>) =>
  async (event: Event): Promise<APIGatewayProxyResultV2> => {
    const log = requestLogger(event);
    const started = Date.now();
    try {
      const result = await handler(event);
      const status = (result as { statusCode?: number }).statusCode ?? 200;
      log.info('Request completed.', { status, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        // Expected refusals are the API working, so they are info rather than error. Without
        // this an authorization check firing looks identical to the database being down.
        log.info('Request refused.', {
          status: error.status,
          code: error.code,
          durationMs: Date.now() - started,
        });
        return json(error.status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      log.error('Unhandled failure.', { error, durationMs: Date.now() - started });
      return json(500, {
        error: { code: 'internal_error', message: 'Something went wrong on our side.' },
      });
    }
  };
