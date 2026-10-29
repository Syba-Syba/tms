import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient, HttpError, isDeadSession } from '../http';

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

describe('isDeadSession', () => {
  it('signs out only for the dead-session code or an unreadable body', () => {
    expect(isDeadSession({ error: { code: 'unauthorised', message: 'Sign in to continue.' } })).toBe(true);
    expect(isDeadSession(null)).toBe(true);
    expect(isDeadSession({ message: 'Unauthorized' })).toBe(true);
    expect(isDeadSession({ error: { code: 'code_wrong' } })).toBe(false);
    expect(isDeadSession({ error: { code: 'password_wrong' } })).toBe(false);
  });
});

describe('createHttpClient 401 handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects a wrong-code 401 with its body and keeps the session', async () => {
    const onUnauthorised = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'code_wrong', message: 'No match.' } })));
    const client = createHttpClient({ baseUrl: 'http://api.test', getToken: () => 't', onUnauthorised });
    const error = await client.post('/x', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).body).toEqual({ error: { code: 'code_wrong', message: 'No match.' } });
    expect(onUnauthorised).not.toHaveBeenCalled();
  });

  it('signs out on a dead-session 401', async () => {
    const onUnauthorised = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'unauthorised' } })));
    const client = createHttpClient({ baseUrl: 'http://api.test', getToken: () => 't', onUnauthorised });
    await expect(client.post('/x', {})).rejects.toBeInstanceOf(HttpError);
    expect(onUnauthorised).toHaveBeenCalledTimes(1);
  });

  it('signs out on a 401 with no body', async () => {
    const onUnauthorised = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => json(401, undefined)));
    const client = createHttpClient({ baseUrl: 'http://api.test', getToken: () => 't', onUnauthorised });
    await expect(client.post('/x', {})).rejects.toBeInstanceOf(HttpError);
    expect(onUnauthorised).toHaveBeenCalledTimes(1);
  });
});
