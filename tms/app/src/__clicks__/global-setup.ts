import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The click tests drive real screens against the real API, which is the point of them: a
 * mocked fetch would have passed through every authorization bug these catch. That only
 * works if the API is up, and for four phases it was left to the developer to remember.
 * The suite was never wired into `npm test` at all, so CI ran none of it.
 *
 * This starts the API and stops it afterwards. It runs on its own port against a throwaway
 * database and storage folder. It used to reuse the development API on 3001, or start one on
 * the development database, so every run left another test property in the demo data a
 * landlord is shown.
 */

export const CLICKS_PORT = 3101;
const API_URL = `http://localhost:${CLICKS_PORT}`;
let scratch: string | undefined;
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../api');
const READY_TIMEOUT_MS = 60_000;

let started: ChildProcess | undefined;

/**
 * 'dev' only for the development API, which answers its root with who you are acting as.
 * The self-hosted server answers on the same port with the app's HTML; reusing it once ran
 * the suite against real tenant data, where the demo accounts do not exist.
 */
const probe = async (): Promise<'dev' | 'other' | 'down'> => {
  try {
    const response = await fetch(API_URL, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return 'other';
    const body = await response.json().catch(() => null);
    return body && typeof body === 'object' && 'actingAs' in body ? 'dev' : 'other';
  } catch {
    return 'down';
  }
};

const isUp = async () => (await probe()) === 'dev';

const waitUntilUp = async (deadline: number) => {
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

export async function setup() {
  const found = await probe();
  if (found === 'dev') {
    console.log(`[clicks] reusing the test API already on ${API_URL}`);
    return;
  }
  if (found === 'other') {
    throw new Error(
      `Something other than the development API is listening on ${API_URL} (the self-hosted ` +
        'server, probably). The click tests create and change records, so they will not run ' +
        'against it. Stop whatever is on that port.',
    );
  }

  if (!existsSync(join(API_DIR, '.env'))) {
    throw new Error('tms/api/.env is missing. Run `npm run env` from the workspace root first.');
  }

  scratch = mkdtempSync(join(tmpdir(), 'tms-clicks-'));
  console.log(`[clicks] starting a test API on ${API_URL} with its own database`);
  started = spawn('npm', ['run', 'dev'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detached so the teardown can kill the whole tree; npm spawns tsx, which spawns node.
    detached: true,
    // vitest sets NODE_ENV=test, and Node's --env-file will not override a variable that is
    // already set, so the API would inherit `test` and refuse to start. The local drivers it
    // uses (pglite, local storage, local KMS) all require development on purpose.
    // --env-file never overrides a variable already set, so these win over tms/api/.env.
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(CLICKS_PORT),
      PUBLIC_API_URL: API_URL,
      PGLITE_DIR: join(scratch, 'db'),
      STORAGE_DIR: join(scratch, 'storage'),
    },
  });

  // Kept so a startup failure reports why instead of only timing out.
  let log = '';
  started.stdout?.on('data', (chunk) => (log += chunk));
  started.stderr?.on('data', (chunk) => (log += chunk));

  if (!(await waitUntilUp(Date.now() + READY_TIMEOUT_MS))) {
    await teardown();
    throw new Error(`API did not come up on ${API_URL} within 60s.\n${log}`);
  }
}

export async function teardown() {
  const folder = scratch;
  scratch = undefined;
  if (started?.pid) {
  // Negative pid signals the process group, so tsx and its child both go.
    try {
      process.kill(-started.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    started = undefined;
  }
  if (folder) {
    // PGlite may still be closing its files for a moment after the signal.
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(folder, { recursive: true, force: true });
  }
}
