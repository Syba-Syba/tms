import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION } from '../domain/privacy';
import { TERMS_VERSION } from '../domain/company';

const APP_LIB = join(dirname(fileURLToPath(import.meta.url)), '../../../app/src/lib');
const appConstant = (file: string, name: string) =>
  readFileSync(join(APP_LIB, file), 'utf8').match(new RegExp(`${name} = '([^']+)'`))?.[1];

/** The app shows a version and the API accepts only the current one: out of step, nobody can agree. */
describe('the versions people agree to', () => {
  it('are the same in the app and the API', () => {
    expect(appConstant('privacy.ts', 'PRIVACY_VERSION')).toBe(PRIVACY_VERSION);
    expect(appConstant('terms.ts', 'TERMS_VERSION')).toBe(TERMS_VERSION);
  });
});
