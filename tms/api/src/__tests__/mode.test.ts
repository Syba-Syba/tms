import { afterEach, describe, expect, it, vi } from 'vitest';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

const load = () => import('../lib/mode');

describe('deployment mode', () => {
  it('is aws whenever nothing says otherwise, so a missing variable never opens anything up', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_MODE;
    const { mode, allowsLocalDrivers } = await load();
    expect(mode()).toBe('aws');
    expect(allowsLocalDrivers()).toBe(false);
  });

  it('reads self-hosted only from an explicit APP_MODE', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'self-hosted';
    const { mode, allowsLocalDrivers } = await load();
    expect(mode()).toBe('self-hosted');
    expect(allowsLocalDrivers()).toBe(true);
  });

  it('ignores APP_MODE in development, which is already the most permissive mode', async () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_MODE = 'aws';
    const { mode } = await load();
    expect(mode()).toBe('development');
  });
});

describe('secrets outside development', () => {
  const strong = 'x'.repeat(48);

  it('refuses the value published in this repository', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'self-hosted';
    const { assertStrongSecret } = await load();
    expect(() => assertStrongSecret('AUTH_SECRET', 'tms-local-dev-secret')).toThrow(/published/);
  });

  it('refuses a short one', async () => {
    const { assertStrongSecret } = await load();
    expect(() => assertStrongSecret('AUTH_SECRET', 'too-short')).toThrow(/characters/);
  });

  it('refuses a missing one', async () => {
    const { assertStrongSecret } = await load();
    expect(() => assertStrongSecret('AUTH_SECRET', undefined)).toThrow(/is not set/);
  });

  it('accepts a generated one', async () => {
    const { assertStrongSecret } = await load();
    expect(() => assertStrongSecret('AUTH_SECRET', strong)).not.toThrow();
  });

  it('still tolerates the development placeholder in development', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTH_SECRET;
    const { secretFor } = await load();
    expect(secretFor('AUTH_SECRET', 'tms-local-dev-secret')).toBe('tms-local-dev-secret');
  });

  it('will not start self-hosted mode without both secrets', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_MODE = 'self-hosted';
    process.env.AUTH_DRIVER = 'local';
    process.env.AUTH_SECRET = strong;
    delete process.env.STORAGE_SECRET;
    const { assertSelfHostedConfig } = await load();
    expect(() => assertSelfHostedConfig()).toThrow(/STORAGE_SECRET/);
  });
});

describe('sign-in routes', () => {
  it('exist wherever there is no Cognito, and nowhere else', async () => {
    // The handler answers 404 in aws mode because API Gateway's authorizer owns identity there.
    for (const [nodeEnv, appMode, expected] of [
      ['development', undefined, true],
      ['production', 'self-hosted', true],
      ['production', undefined, false],
    ] as const) {
      process.env.NODE_ENV = nodeEnv;
      if (appMode) process.env.APP_MODE = appMode;
      else delete process.env.APP_MODE;
      vi.resetModules();
      const { mode } = await load();
      expect(mode() !== 'aws').toBe(expected);
    }
  });
});
