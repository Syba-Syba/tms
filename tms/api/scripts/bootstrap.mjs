#!/usr/bin/env node
/**
 * Creates the first landlord in a self-hosted database: the `landlord` row that owns the
 * portfolio, and the `local_credential` row that signs in to it.
 *
 * A freshly migrated database has neither. The only insert into `landlord` anywhere in the
 * repository is in 0002_seed_dev.sql, which the migration runner skips because it is seed
 * data, so without this a self-hosted install has nobody who can sign in and every landlord
 * route answers 403.
 *
 *   npm run bootstrap -- --email you@example.co.za --name "Mokoena Properties"
 *
 * The password is read from BOOTSTRAP_PASSWORD so it never lands in shell history.
 */
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';

const arg = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

// Sign-in lowercases the email before looking it up, so a landlord created as
// Name@Example.com could never sign in. Store it the way it will be searched for.
const email = arg('--email')?.trim().toLowerCase();
const name = arg('--name');
const phone = arg('--phone') ?? '';
const password = process.env.BOOTSTRAP_PASSWORD;

if (!email || !name || !password) {
  console.error('Usage: BOOTSTRAP_PASSWORD=... npm run bootstrap -- --email <email> --name <trading name> [--phone <phone>]');
  process.exit(1);
}
if (password.length < 12) {
  console.error('BOOTSTRAP_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

// Same format lib/passwords.ts writes and verifies.
const salt = randomBytes(16).toString('hex');
const passwordHash = `scrypt:${salt}:${scryptSync(password, salt, 32).toString('hex')}`;

const { query, withTransaction } = await import('../src/lib/db.ts');

const existing = await query('select sub from local_credential where role = $1 limit 1', ['landlord']);
if (existing.length > 0) {
  console.error(`A landlord already exists (${existing[0].sub}). Refusing to create a second one.`);
  process.exit(1);
}

const sub = `landlord-${randomUUID()}`;
const landlordId = randomUUID();

await withTransaction(async (run) => {
  await run(
    'insert into landlord (id, trading_name, email, phone, cognito_sub) values ($1, $2, $3, $4, $5)',
    [landlordId, name, email, phone, sub],
  );
  await run(
    'insert into local_credential (sub, email, name, role, password_hash) values ($1, $2, $3, $4, $5)',
    [sub, email, name, 'landlord', passwordHash],
  );
});

console.log(`Created landlord "${name}"`);
console.log(`  sign in as : ${email}`);
console.log(`  landlord id: ${landlordId}`);
console.log(`  subject    : ${sub}`);
