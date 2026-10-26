#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const dryRun = process.argv.includes('--dry-run');
const withSeed = process.argv.includes('--seed');

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql') && !name.includes('seed'))
  .sort();

const CA_PATH =
  process.env.RDS_CA_BUNDLE ?? join(dirname(fileURLToPath(import.meta.url)), '../certs/rds-global-bundle.pem');

/** The same bundle and the same secret the API uses, so migrating connects the way it will. */
function caBundle() {
  try {
    return readFileSync(CA_PATH, 'utf8');
  } catch {
    throw new Error(
      `No RDS CA bundle at ${CA_PATH}. Run "npm run certs:fetch" first, or set RDS_CA_BUNDLE.`,
    );
  }
}

async function password() {
  if (process.env.DB_PASSWORD) return process.env.DB_PASSWORD;
  if (!process.env.DB_SECRET_ARN) {
    throw new Error('Set DB_PASSWORD for a local database, or DB_SECRET_ARN to read one from Secrets Manager.');
  }
  const { GetSecretValueCommand, SecretsManagerClient } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }),
  );
  if (!SecretString) throw new Error(`Secret ${process.env.DB_SECRET_ARN} holds no SecretString.`);
  try {
    return JSON.parse(SecretString).password;
  } catch {
    return SecretString;
  }
}

/** Same two drivers the API uses, so migrating matches how the app will actually connect. */
async function connect() {
  if (process.env.DB_DRIVER === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = await PGlite.create(process.env.PGLITE_DIR ?? './.pglite', {
      parsers: { 1082: (value) => value, 1182: (value) => value },
    });
    return {
      label: `PGlite at ${process.env.PGLITE_DIR ?? './.pglite'}`,
      query: (text, params = []) => db.query(text, params),
      exec: (text) => db.exec(text),
      end: () => db.close(),
    };
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'tms',
    user: process.env.DB_USER ?? 'tms_app',
    password: await password(),
    // rejectUnauthorized with no ca falls back to the public roots, which do not include the
    // RDS authority, so migrating against RDS failed on an unverifiable certificate.
    ssl: process.env.DB_SSL === 'off' ? undefined : { ca: caBundle(), rejectUnauthorized: true },
  });
  await client.connect();
  return {
    label: `Postgres at ${process.env.DB_HOST}/${process.env.DB_NAME ?? 'tms'}`,
    query: (text, params = []) => client.query(text, params),
    exec: (text) => client.query(text),
    end: () => client.end(),
  };
}

const db = await connect();
console.log(`Migrating ${db.label}`);

await db.exec(`
  create table if not exists schema_migrations (
    filename    text primary key,
    checksum    text        not null,
    applied_at  timestamptz not null default now()
  )`);

const { rows: applied } = await db.query('select filename, checksum from schema_migrations');
const seen = new Map(applied.map((row) => [row.filename, row.checksum]));

let ran = 0;
for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const previous = seen.get(file);

  if (previous) {
    // An already-applied file that has been edited means the database and the repository
    // disagree about what the schema is. Stop rather than guess.
    if (previous !== checksum) {
      console.error(`\n${file} has changed since it was applied.`);
      console.error('Applied migrations are immutable. Add a new migration instead.\n');
      process.exit(1);
    }
    continue;
  }

  console.log(`${dryRun ? 'would apply' : 'applying'} ${file}`);
  if (dryRun) continue;

  // Each migration is one transaction, so a failure halfway leaves nothing behind.
  await db.exec('begin');
  try {
    await db.exec(sql);
    await db.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [
      file,
      checksum,
    ]);
    await db.exec('commit');
    ran += 1;
  } catch (error) {
    await db.exec('rollback');
    console.error(`\n${file} failed. Nothing was applied from it.\n`);
    throw error;
  }
}

console.log(dryRun ? `${files.length - seen.size} pending` : `${ran} applied, ${seen.size} already there`);

if (withSeed && !dryRun) {
  const { rows } = await db.query('select count(*)::int as n from landlord');
  if (rows[0].n > 0) {
    console.log('Seed skipped, there is already data here.');
  } else {
    // Every seed file, in order, so a new one is picked up without editing this script.
    const seeds = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql') && name.includes('seed'))
      .sort();
    for (const seed of seeds) {
      await db.exec(readFileSync(join(MIGRATIONS, seed), 'utf8'));
    }
    console.log(`Seeded development data (${seeds.length} files).`);
  }
}

await db.end();
