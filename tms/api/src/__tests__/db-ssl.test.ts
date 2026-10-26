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
    expect(() => getPool()).toThrow(/DB_SSL=off needs/);
  });

  /* Self-hosted mode runs with NODE_ENV=production, so the old guard would have forced TLS on
     a Postgres reached over loopback, which has no certificate to present. */
  it('allows a plaintext connection to a self-hosted database on loopback', async () => {
    process.env.DB_SSL = 'off';
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'self-hosted';
    process.env.DB_HOST = '127.0.0.1';
    const { getPool } = await import('../lib/db');
    expect(() => getPool()).not.toThrow();
  });

  it('still refuses when a self-hosted database is across a network', async () => {
    process.env.DB_SSL = 'off';
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'self-hosted';
    process.env.DB_HOST = 'db.example.co.za';
    const { getPool } = await import('../lib/db');
    expect(() => getPool()).toThrow(/DB_SSL=off needs/);
  });
});
