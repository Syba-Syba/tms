import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg, { Pool } from 'pg';
import { env } from './env';
import { logger } from './logger';
import { allowsLocalDrivers, isDevelopment, isSelfHosted } from './mode';
import { databasePassword } from './secrets';

/** A database reached over loopback never puts bytes on a network. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * The bundle ships inside the deployment package, next to the code that reads it. It used to
 * default to a path under /opt, which is where a Lambda layer mounts, and no layer was ever
 * declared: every deployed function died here before opening a socket.
 *
 * LAMBDA_TASK_ROOT is set by the runtime and is where the package is unpacked. Locally there
 * is no such variable, so the same file resolves from the api directory.
 */
const RDS_CA_PATH =
  process.env.RDS_CA_BUNDLE ??
  join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), 'certs', 'rds-global-bundle.pem');

/**
 * Postgres DATE columns arrive as JS Dates set to local midnight, which JSON then renders in
 * UTC. Two hours west of Johannesburg that turns 29 August into "2026-08-28T22:00:00Z", so a
 * lease start, an invoice due date or a statutory refund deadline reads a day early. Lambda
 * runs in UTC and hides this; a laptop in SAST does not.
 *
 * A date has no time and no timezone, so it is handed back as the plain 'YYYY-MM-DD' string
 * Postgres stored. 1082 is DATE, 1182 is DATE[].
 */
pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(1182 as unknown as number, (value: string) => value);

/**
 * TLS is on everywhere except a local database, which has no certificate to verify. Reading
 * the bundle unconditionally meant `npm run dev` died on a missing file before it could
 * connect to anything.
 *
 * DB_SSL=off is refused outside development and self-hosted-on-loopback, so this cannot
 * quietly disable TLS on anything that crosses a network.
 */
function sslConfig() {
  if (process.env.DB_SSL === 'off') {
    if (isDevelopment()) return undefined;
    // A self-hosted Postgres on the same machine has no certificate and needs none: the
    // traffic never leaves the loopback interface. Anywhere else it crosses a network, so
    // turning TLS off would be exactly the mistake this guard exists to prevent.
    if (isSelfHosted() && LOOPBACK.has(env.DB_HOST)) return undefined;
    throw new Error(
      `DB_SSL=off needs NODE_ENV=development, or self-hosted mode with the database on ` +
        `localhost. DB_HOST is ${env.DB_HOST}.`,
    );
  }
  // rejectUnauthorized:false would accept any certificate, which defeats the point.
  return { ca: readCaBundle(), rejectUnauthorized: true };
}

function readCaBundle() {
  try {
    return readFileSync(RDS_CA_PATH, 'utf8');
  } catch {
    // ENOENT here used to surface as a bare path with no indication of what was meant to put
    // a file there, on every route at once.
    throw new Error(
      `No RDS CA bundle at ${RDS_CA_PATH}. Run "npm run certs:fetch" in tms/api before ` +
        'deploying, or point RDS_CA_BUNDLE at a bundle already on the machine.',
    );
  }
}

/**
 * pg accepts a function here and awaits it when it opens a connection, so the secret is
 * fetched lazily and a container that never touches Postgres never asks for it.
 *
 * DB_PASSWORD short-circuits it for a local Postgres, which has no Secrets Manager to ask.
 */
const resolvePassword = async () => process.env.DB_PASSWORD ?? (await databasePassword());

/** Every caller goes through this shape, so the driver underneath can change. */
export interface Driver {
  run<T>(text: string, params: unknown[]): Promise<T[]>;
  transaction<T>(fn: (run: typeof query) => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------------ *
 * Postgres, used in every deployed stage
 * ------------------------------------------------------------------ */

let pool: Pool | undefined;

export function getPool() {
  pool ??= new Pool({
    host: env.DB_HOST,
    database: env.DB_NAME,
    user: process.env.DB_USER ?? 'tms_app',
    password: resolvePassword,
    port: Number(process.env.DB_PORT ?? 5432),
    // Two is right for Lambda, where each container serves one request at a time. The
    // self-hosted server serves many at once, and with two connections a pair of requests
    // each holding one inside a transaction and waiting for a second never finished.
    max: Number(process.env.DB_POOL_MAX ?? (isSelfHosted() ? 10 : 2)),
    idleTimeoutMillis: 10_000,
    ssl: sslConfig(),
  });
  return pool;
}

const postgresDriver: Driver = {
  async run<T>(text: string, params: unknown[]) {
    return (await getPool().query(text, params)).rows as T[];
  },
  async transaction<T>(fn: (run: typeof query) => Promise<T>) {
    const client = await getPool().connect();
    try {
      await client.query('begin');
      const scoped = async <R>(text: string, params: unknown[] = []) =>
        (await client.query(text, params)).rows as R[];
      const result = await fn(scoped as typeof query);
      await client.query('commit');
      return result;
    } catch (error) {
      // A failing rollback must not replace the error that caused it.
      await client.query('rollback').catch((rollbackError) => {
        logger.error('Rollback failed.', { error: rollbackError });
      });
      throw error;
    } finally {
      client.release();
    }
  },
};

/* ------------------------------------------------------------------ *
 * PGlite, development and small self-hosted installs
 * ------------------------------------------------------------------ *
 *
 * The same Postgres engine compiled to WebAssembly, running in this process against a folder
 * on disk. It exists so that starting this project needs nothing installed: no Homebrew, no
 * database server, no role to create. Set DB_DRIVER=pglite.
 *
 * It is refused in aws mode, where RDS exists. It is a real Postgres, but a single-process
 * one with no replication and no pg_dump, so self-hosting on it warns once at startup.
 */
let warnedAboutPglite = false;
interface PgliteQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
interface PgliteDb extends PgliteQueryable {
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteQueryable) => Promise<T>): Promise<T>;
}
let pglite: Promise<PgliteDb> | undefined;

function getPglite() {
  if (!allowsLocalDrivers()) {
    throw new Error('DB_DRIVER=pglite is not permitted in aws mode. Use Postgres, or set APP_MODE=self-hosted.');
  }
  if (isSelfHosted() && !warnedAboutPglite) {
    warnedAboutPglite = true;
    // It is a real Postgres, but one process against one folder, with no replication and no
    // pg_dump. Someone running this for real needs to know the backup story is "copy the
    // directory while the server is stopped".
    logger.warn('Running on PGlite. Back up PGLITE_DIR regularly; consider Postgres instead.', {
      dir: process.env.PGLITE_DIR ?? './.pglite',
    });
  }
  pglite ??= import('@electric-sql/pglite').then(({ PGlite }) =>
    PGlite.create(process.env.PGLITE_DIR ?? './.pglite', {
      // PGlite parses types itself, so the pg.types override above does not reach it. Without
      // this a date becomes an instant here and reads a day early, exactly as it did on pg.
      parsers: { 1082: (value: string) => value, 1182: (value: string) => value },
    }),
  ) as never;
  return pglite!;
}

const pgliteDriver: Driver = {
  async run<T>(text: string, params: unknown[]) {
    const db = await getPglite();
    return (await db.query(text, params)).rows as T[];
  },
  async transaction<T>(fn: (run: typeof query) => Promise<T>) {
    const db = await getPglite();
    // PGlite is one connection. A bare `begin` on it let every other request's queries run
    // inside this transaction, and a rollback took their writes with it. Its own transaction()
    // holds the connection's lock until the callback settles, so the others queue behind it.
    return db.transaction(async (tx) => {
      const scoped = async <R>(text: string, params: unknown[] = []) =>
        (await tx.query(text, params)).rows as R[];
      return fn(scoped as typeof query);
    });
  },
};

const driver = (): Driver => (process.env.DB_DRIVER === 'pglite' ? pgliteDriver : postgresDriver);

export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return driver().run<T>(text, params);
}

export async function withTransaction<T>(fn: (run: typeof query) => Promise<T>): Promise<T> {
  return driver().transaction(fn);
}

/**
 * Runs a script containing several statements, which `query` cannot do on either driver.
 * Migrations and the development seed are the only callers.
 */
export async function execScript(sql: string): Promise<void> {
  if (process.env.DB_DRIVER === 'pglite') {
    const db = await getPglite();
    await db.exec(sql);
    return;
  }
  await getPool().query(sql);
}
