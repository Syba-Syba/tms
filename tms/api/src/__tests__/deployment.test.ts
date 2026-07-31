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

  it('grants the dispatcher permission to send mail', () => {
    const actions = config.provider.iam.role.statements.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions).toContain('ses:SendEmail');
  });
});
