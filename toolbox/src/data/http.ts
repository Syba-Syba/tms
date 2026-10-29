import { retry } from '../utils/async';

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: unknown,
  ) {
    super(`Request to ${url} failed with ${status}.`);
    this.name = 'HttpError';
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  getToken?: () => string | null | Promise<string | null>;
  onUnauthorised?: () => void | Promise<void>;
  /** A function is resolved per request, so headers that change at runtime are picked up. */
  defaultHeaders?: Record<string, string> | (() => Record<string, string>);
  timeoutMs?: number;
  retryAttempts?: number;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  raw?: boolean;
}

export function createHttpClient(options: HttpClientOptions) {
  const { baseUrl, getToken, onUnauthorised, defaultHeaders = {}, timeoutMs = 30000, retryAttempts = 2 } = options;
  let refreshing: Promise<void> | null = null;

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
    const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    Object.entries(init.query ?? {}).forEach(([key, value]) => {
      if (value !== undefined) url.searchParams.set(key, String(value));
    });

    // Remembered per request so a 401 can be read for what it is: a dead session when a token
    // was sent, an ordinary refusal (a wrong password on sign-in) when none was.
    let sentToken = false;
    const send = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const token = await getToken?.();
      sentToken = Boolean(token);
      const headers = typeof defaultHeaders === 'function' ? defaultHeaders() : defaultHeaders;
      try {
        return await fetch(url, {
          ...init,
          signal: init.signal ?? controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...init.headers,
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      } finally {
        clearTimeout(timer);
      }
    };

    // Only idempotent verbs are retried, so a failed POST never creates two records.
    const method = (init.method ?? 'GET').toUpperCase();
    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const response = idempotent
      ? await retry(send, { attempts: retryAttempts, shouldRetry: (e) => !(e instanceof HttpError) })
      : await send();

    // A 401 on a request that carried no token is not an expired session. Treating it as one
    // reloaded the sign-in page on a wrong password, hid the error, and sent the attempt twice,
    // which counted double against the lockout.
    //
    // Even with a token, only a 401 that says the session itself is dead ('unauthorised', or no
    // readable body at all, as a gateway sends) signs out. A 401 for a wrong confirmation code
    // or password inside the app is an answer for the screen to show, not a reason to throw the
    // user out mid-form. Read from a clone so the error path below can still read the body.
    if (response.status === 401 && onUnauthorised && sentToken && isDeadSession(await safeBody(response.clone()))) {
      refreshing ??= Promise.resolve(onUnauthorised()).finally(() => {
        refreshing = null;
      });
      await refreshing;
      const retried = await send();
      if (!retried.ok) throw new HttpError(retried.status, url.toString(), await safeBody(retried));
      return parse<T>(retried, init.raw);
    }

    if (!response.ok) throw new HttpError(response.status, url.toString(), await safeBody(response));
    return parse<T>(response, init.raw);
  }

  const parse = async <T>(response: Response, raw?: boolean): Promise<T> => {
    if (raw) return response as unknown as T;
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };

  const safeBody = async (response: Response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  return {
    request,
    get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'POST', body }),
    put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'PUT', body }),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'PATCH', body }),
    delete: <T>(path: string, options?: RequestOptions) =>
      request<T>(path, { ...options, method: 'DELETE' }),
  };
}

/**
 * Whether a 401 body means the session is gone. The API answers a dead or invalid token with
 * error.code 'unauthorised'; anything else carrying a code is a refusal the screen explains.
 * A missing or unparseable body (a gateway or proxy 401) is treated as a dead session.
 */
export function isDeadSession(body: unknown): boolean {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  if (body === null || body === undefined || typeof body !== 'object' || code === undefined) return true;
  return code === 'unauthorised';
}

export type HttpClient = ReturnType<typeof createHttpClient>;
