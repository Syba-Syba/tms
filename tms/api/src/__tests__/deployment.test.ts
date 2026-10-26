import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const config = parse(readFileSync(join(API_ROOT, 'serverless.yml'), 'utf8'));

/** The deployment file was invalid YAML for five phases: a route path holding {id} inside a
    flow mapping is not a plain scalar, so serverless could never have parsed it. */
describe('serverless.yml', () => {
  it('parses as YAML', () => {
    expect(config.functions).toBeTypeOf('object');
  });

  it('quotes any route path that sits inside a flow mapping', () => {
    // Braces are legal in a block scalar. They are not legal in a plain scalar inside
    // { }, which is what silently broke this file for five phases.
    const raw = readFileSync(join(API_ROOT, 'serverless.yml'), 'utf8');
    const flowLines = raw.split('\n').filter((line) => line.includes('httpApi: {'));
    const unquoted = flowLines.filter((line) => /path: [^'"]*\{/.test(line));
    expect(unquoted).toEqual([]);
  });

  it('serves every route from one function', () => {
    const httpFunctions = Object.entries<any>(config.functions).filter((entry) =>
      (entry[1].events ?? []).some((event: any) => event.httpApi),
    );
    expect(httpFunctions.map(([name]) => name)).toEqual(['api']);
  });

  it('sets a log retention, so groups do not keep logs forever', () => {
    expect(config.provider.logRetentionInDays).toBeGreaterThan(0);
  });

  it('points every function at a handler file that exists', () => {
    const missing: string[] = [];
    for (const [name, fn] of Object.entries<any>(config.functions)) {
      const file = String(fn.handler).replace(/\.[^.]+$/, '');
      if (!existsSync(join(API_ROOT, `${file}.ts`))) missing.push(`${name} -> ${fn.handler}`);
    }
    expect(missing).toEqual([]);
  });

  it('gives every HTTP route an authorizer', () => {
    const open: string[] = [];
    for (const [name, fn] of Object.entries<any>(config.functions)) {
      for (const event of fn.events ?? []) {
        if (event.httpApi && !event.httpApi.authorizer) open.push(`${name} ${event.httpApi.path}`);
      }
    }
    expect(open).toEqual([]);
  });

  /* The suite below was green while the package held .ts files and no dependencies, because
     everything here checked the source layout and nothing checked the artifact. */

  it('compiles the handlers, which are TypeScript and the runtime is not', () => {
    expect(config.plugins ?? []).toContain('serverless-esbuild');
    expect(config.custom.esbuild.bundle).toBe(true);
  });

  it('keeps the development-only database driver out of the package', () => {
    expect(config.custom.esbuild.exclude).toContain('@electric-sql/pglite');
  });

  it('gives the ESM bundle a require, which bundled CommonJS dependencies call', () => {
    // Without this pg throws 'Dynamic require of "events" is not supported' at import time.
    expect(config.custom.esbuild.banner.js).toMatch(/createRequire/);
  });

  it('reads the database certificate from the package, not from an undeclared layer', () => {
    const raw = readFileSync(join(API_ROOT, 'src/lib/db.ts'), 'utf8');
    expect(raw).not.toMatch(/\/opt\/rds-ca-bundle\.pem/);
    expect(config.provider.environment.RDS_CA_BUNDLE).toMatch(/certs\/rds-global-bundle\.pem$/);
  });

  it('reads the database password from Secrets Manager, which nothing used to do', () => {
    const raw = readFileSync(join(API_ROOT, 'src/lib/secrets.ts'), 'utf8');
    expect(raw).toMatch(/GetSecretValueCommand/);
    expect(config.provider.environment.DB_SECRET_ARN).toBeTruthy();
  });

  it('answers cross-origin calls, which every browser and WebView client makes', () => {
    expect(config.provider.httpApi.cors.allowedHeaders).toContain('authorization');
  });

  it('puts the functions in the VPC the database lives in', () => {
    expect(config.provider.vpc.subnetIds).toBeTruthy();
    expect(config.provider.vpc.securityGroupIds).toBeTruthy();
  });

  it('carries the notification settings the dispatcher reads', () => {
    expect(config.provider.environment.NOTIFY_MODE).toBeTruthy();
    expect(config.provider.environment.NOTIFY_FROM).toBeTruthy();
  });

  it('allows the KMS call an SSE-KMS upload actually makes', () => {
    const actions = config.provider.iam.role.statements.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    // PutObject with SSE-KMS is a GenerateDataKey, not an Encrypt.
    expect(actions.some((a: string) => a.startsWith('kms:GenerateDataKey'))).toBe(true);
  });

  it('excludes the committed dev database, local storage and .env from the package', () => {
    for (const pattern of ['!.pglite/**', '!.storage/**', '!.env']) {
      expect(config.package.patterns).toContain(pattern);
    }
  });

  it('grants the dispatcher permission to send mail', () => {
    const actions = config.provider.iam.role.statements.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions).toContain('ses:SendEmail');
  });
});
