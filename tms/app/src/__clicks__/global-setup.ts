import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The click tests drive real screens against the real API, which is the point of them: a
 * mocked fetch would have passed through every authorization bug these catch. That only
 * works if the API is up, and for four phases it was left to the developer to remember.
 * The suite was never wired into `npm test` at all, so CI ran none of it.
 *
 * This starts the API when nothing is listening and stops it afterwards. An API you started
 * yourself is reused and left running, so the usual `npm run dev` loop is unaffected.
 */

const API_URL = process.env.VITE_API_URL ?? 'http://localhost:3001';
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../api');
const READY_TIMEOUT_MS = 60_000;

let started: ChildProcess | undefined;

const isUp = async () => {
  try {
    const response = await fetch(API_URL, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
};

const waitUntilUp = async (deadline: number) => {
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

export async function setup() {
  if (await isUp()) {
    console.log(`[clicks] reusing the API already on ${API_URL}`);
    return;
  }

  if (!existsSync(join(API_DIR, '.env'))) {
    throw new Error('tms/api/.env is missing. Run `npm run env` from the workspace root first.');
  }

  console.log(`[clicks] starting the API on ${API_URL}`);
  started = spawn('npm', ['run', 'dev'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Detached so the teardown can kill the whole tree; npm spawns tsx, which spawns node.
    detached: true,
    // vitest sets NODE_ENV=test, and Node's --env-file will not override a variable that is
    // already set, so the API would inherit `test` and refuse to start. The local drivers it
    // uses (pglite, local storage, local KMS) all require development on purpose.
    env: { ...process.env, NODE_ENV: 'development' },
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
  if (!started?.pid) return;
  // Negative pid signals the process group, so tsx and its child both go.
  try {
    process.kill(-started.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  started = undefined;
}
