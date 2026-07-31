import { afterEach, describe, expect, it, vi } from 'vitest';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

/** Found by running the local server: the CA bundle was read even with TLS turned off, so
    `npm run dev` died on a missing certificate before it could reach Postgres. */
describe('database TLS', () => {
  it('allows a plaintext connection only in development', async () => {
    process.env.DB_SSL = 'off';
    process.env.NODE_ENV = 'development';
    const { getPool } = await import('../lib/db');
    expect(() => getPool()).not.toThrow();
  });

  it('refuses to disable TLS in a deployed stage', async () => {
    process.env.DB_SSL = 'off';
    process.env.NODE_ENV = 'production';
    const { getPool } = await import('../lib/db');
    expect(() => getPool()).toThrow(/only allowed when NODE_ENV=development/);
  });
});
