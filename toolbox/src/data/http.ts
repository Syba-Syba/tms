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

    const send = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const token = await getToken?.();
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

    if (response.status === 401 && onUnauthorised) {
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

export type HttpClient = ReturnType<typeof createHttpClient>;
