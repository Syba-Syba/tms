import { readFileSync } from 'node:fs';
import pg, { Pool } from 'pg';
import { env } from './env';

const RDS_CA_PATH = process.env.RDS_CA_BUNDLE ?? '/opt/rds-ca-bundle.pem';

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
 * DB_SSL=off is refused outside development, so this cannot quietly disable TLS in a
 * deployed stage.
 */
function sslConfig() {
  if (process.env.DB_SSL === 'off') {
    if (process.env.NODE_ENV !== 'development') {
      throw new Error('DB_SSL=off is only allowed when NODE_ENV=development.');
    }
    return undefined;
  }
  // rejectUnauthorized:false would accept any certificate, which defeats the point.
  return { ca: readFileSync(RDS_CA_PATH, 'utf8'), rejectUnauthorized: true };
}

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
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT ?? 5432),
    max: 2,
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
        console.error('Rollback failed', rollbackError);
      });
      throw error;
    } finally {
      client.release();
    }
  },
};

/* ------------------------------------------------------------------ *
 * PGlite, development only
 * ------------------------------------------------------------------ *
 *
 * The same Postgres engine compiled to WebAssembly, running in this process against a folder
 * on disk. It exists so that starting this project needs nothing installed: no Homebrew, no
 * database server, no role to create. Set DB_DRIVER=pglite.
 *
 * It is refused outside development. It is a real Postgres, but a single-process one.
 */
let pglite: Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; exec(sql: string): Promise<unknown> }> | undefined;

function getPglite() {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('DB_DRIVER=pglite is only allowed when NODE_ENV=development.');
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
    await db.exec('begin');
    try {
      const result = await fn(query);
      await db.exec('commit');
      return result;
    } catch (error) {
      await db.exec('rollback').catch(() => undefined);
      throw error;
    }
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
