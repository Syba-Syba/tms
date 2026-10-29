#!/usr/bin/env node
/**
 * Reads the database and reports anything that breaks the app's rules: rows that disagree with
 * each other, money that does not add up, files the database points at that are missing.
 * It changes nothing. Exit code 1 when an error is found, so it can gate a deploy or a backup.
 *
 *   npm run db:check                 development database (.env)
 *   npm run db:check:selfhosted      the self-hosted database (.env.selfhosted)
 *
 * PGlite is one process: stop `npm run dev` before checking the development database.
 */
import { existsSync } from 'node:fs';

const { query } = await import('../src/lib/db.ts');
const { localPathFor } = await import('../src/lib/storage.ts');

/** Each check returns the offending rows. Errors break the app or the books; warnings are odd. */
const CHECKS = [
  // ---- Units and leases
  ['error', 'Unit marked occupied with no active lease', `
    select p.name || ' ' || u.code as unit from unit u join property p on p.id = u.property_id
     where u.status = 'occupied' and not exists (select 1 from lease l where l.unit_id = u.id and l.status = 'active')`],
  ['error', 'Unit with an active lease not marked occupied', `
    select p.name || ' ' || u.code as unit, u.status from unit u join property p on p.id = u.property_id
     where u.status <> 'occupied' and exists (select 1 from lease l where l.unit_id = u.id and l.status = 'active')`],
  ['error', 'Unit with more than one active lease', `
    select unit_id, count(*)::int as leases from lease where status = 'active' group by unit_id having count(*) > 1`],
  ['error', 'Lease that ends on or before it starts', `
    select 'LSE-' || lpad(ref_no::text, 5, '0') as lease, start_date::text, end_date::text from lease where end_date <= start_date`],
  ['error', 'Lease on a different unit or person from its application', `
    select 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease from lease l join application a on a.id = l.application_id
     where a.unit_id <> l.unit_id or a.applicant_id <> l.applicant_id`],
  ['warn', 'Unit held for an applicant with no open application', `
    select p.name || ' ' || u.code as unit from unit u join property p on p.id = u.property_id
     where u.status = 'held' and not exists (select 1 from application a where a.unit_id = u.id and a.status in ('submitted', 'screening', 'approved'))
       and not exists (select 1 from lease l where l.unit_id = u.id and l.status in ('draft', 'out_for_signature', 'scheduled'))`],

  // ---- Money
  ['error', 'Payment against an invoice of a different lease', `
    select pay.id, pay.amount_cents from payment pay join invoice i on i.id = pay.invoice_id where i.lease_id <> pay.lease_id`],
  ['error', 'Invoice marked paid but payments against it fall short', `
    select 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease, i.period_start::text, i.total_cents,
           coalesce((select sum(amount_cents) from payment where invoice_id = i.id), 0)::bigint as paid
      from invoice i join lease l on l.id = i.lease_id
     where i.status = 'paid' and coalesce((select sum(amount_cents) from payment where invoice_id = i.id), 0) < i.total_cents`],
  ['error', 'Invoice still open but paid in full', `
    select 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease, i.period_start::text, i.status, i.total_cents
      from invoice i join lease l on l.id = i.lease_id
     where i.status in ('issued', 'part_paid') and i.total_cents > 0
       and coalesce((select sum(amount_cents) from payment where invoice_id = i.id), 0) >= i.total_cents`],
  ['warn', 'Invoice paid more than its total', `
    select 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease, i.period_start::text, i.total_cents,
           (select sum(amount_cents) from payment where invoice_id = i.id)::bigint as paid
      from invoice i join lease l on l.id = i.lease_id
     where coalesce((select sum(amount_cents) from payment where invoice_id = i.id), 0) > i.total_cents`],
  ['error', 'Invoice whose lines do not add up to its total', `
    select i.id, i.total_cents, sum(il.amount_cents)::bigint as lines from invoice i join invoice_line il on il.invoice_id = i.id
     group by i.id having sum(il.amount_cents) <> i.total_cents`],
  ['error', 'Deposit balance below zero', `
    select 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease,
           sum(case when d.entry_type in ('received', 'interest') then d.amount_cents else -d.amount_cents end)::bigint as balance
      from deposit_ledger d join lease l on l.id = d.lease_id group by l.ref_no
    having sum(case when d.entry_type in ('received', 'interest') then d.amount_cents else -d.amount_cents end) < 0`],
  ['warn', 'Active lease with no deposit received', `
    select 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease from lease l
     where l.status = 'active' and l.deposit_cents > 0
       and not exists (select 1 from deposit_ledger d where d.lease_id = l.id and d.entry_type = 'received')`],
  ['warn', 'Expense on a property of a different landlord', `
    select e.id, e.description from expense e join property p on p.id = e.property_id where p.landlord_id <> e.landlord_id`],

  // ---- Landlord accounts and billing
  ['error', 'Landlord with no owner', `
    select trading_name from landlord l where not exists (select 1 from landlord_member m where m.landlord_id = l.id and m.role = 'owner')`],
  ['error', 'Landlord with no subscription row', `
    select trading_name from landlord l where not exists (select 1 from subscription s where s.landlord_id = l.id)`],
  ['error', 'Landlord sign-in with no landlord account', `
    select c.email from local_credential c where c.role = 'landlord' and not exists (select 1 from landlord_member m where m.sub = c.sub)`],
  ['error', 'Paid subscription payment with no invoice', `
    select e.id, e.created_at::text from billing_event e
     where e.kind = 'paid' and e.verified and e.created_at >= '2026-10-28'
       and not exists (select 1 from billing_invoice b where b.billing_event_id = e.id)`],
  ['warn', 'Tenant sign-in not linked to an applicant record', `
    select c.email from local_credential c where c.role = 'tenant' and not exists (select 1 from applicant a where a.cognito_sub = c.sub)`],

  // ---- Applications, consent and privacy
  ['error', 'Credit check recorded without the applicant agreeing', `
    select c.application_id from credit_check c
     where not exists (select 1 from consent k where k.kind = 'credit_check' and k.subject_id = c.application_id)`],
  ['error', 'Application with no screening consent on record', `
    select a.id, a.status from application a
     where a.status <> 'draft' and a.submitted_at > $1
       and not exists (select 1 from consent k where k.kind = 'application_screening' and k.subject_id = a.id)`],
  ['warn', 'Listing photo upload never confirmed (older than a day)', `
    select unit_id, created_at::text from unit_photo where not uploaded and created_at < now() - interval '1 day'`],
];

/** Files the database points at that should exist in storage. Local storage only. */
const FILE_QUERIES = [
  ['application document', `select s3_key as key from application_document`],
  ['listing photo', `select s3_key as key from unit_photo where uploaded`],
  ['lease PDF', `select pdf_s3_key as key from lease where pdf_s3_key is not null`],
  ['invoice PDF', `select pdf_s3_key as key from invoice where pdf_s3_key is not null`],
  ['proof of payment', `select s3_key as key from payment_proof where s3_key not like 'erased/%'`],
  ['subscription invoice PDF', `select pdf_s3_key as key from billing_invoice where pdf_s3_key is not null`],
];

let errors = 0;
let warnings = 0;
const show = (rows) => rows.slice(0, 5).map((row) => '      ' + Object.values(row).join('  ')).join('\n');

// Rules apply from the day they shipped: an application older than the consent table is not
// expected to carry a consent row.
const [consentSince] = await query(
  `select coalesce((select applied_at from schema_migrations where filename = '0023_privacy.sql'), '-infinity'::timestamptz)::text as at`,
).catch(() => [{ at: '-infinity' }]);

for (const [level, title, sql] of CHECKS) {
  const rows = await query(sql, sql.includes('$1') ? [consentSince.at] : []);
  if (rows.length === 0) {
    console.log(`  ok    ${title}`);
    continue;
  }
  if (level === 'error') errors += 1; else warnings += 1;
  console.log(`  ${level === 'error' ? 'ERROR' : 'warn '} ${title}: ${rows.length}\n${show(rows)}${rows.length > 5 ? `\n      and ${rows.length - 5} more` : ''}`);
}

if ((process.env.STORAGE_DRIVER ?? 'local') === 'local') {
  for (const [what, sql] of FILE_QUERIES) {
    const rows = await query(sql);
    const missing = rows.filter((row) => !existsSync(localPathFor(row.key)));
    if (missing.length === 0) {
      console.log(`  ok    Every ${what} file is in storage (${rows.length})`);
    } else {
      errors += 1;
      console.log(`  ERROR ${what} files missing from storage: ${missing.length} of ${rows.length}\n${show(missing)}`);
    }
  }
} else {
  console.log('  skip  File checks: storage is S3, check the bucket with its own tools.');
}

const counts = (await query(`select
  (select count(*) from landlord)::int as landlords, (select count(*) from property)::int as properties,
  (select count(*) from unit)::int as units, (select count(*) from lease where status = 'active')::int as active_leases,
  (select count(*) from invoice)::int as invoices, (select count(*) from payment)::int as payments`))[0];
console.log(`\n  ${Object.entries(counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}`);
console.log(errors === 0 ? `  No errors${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.` : `  ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`);
process.exit(errors === 0 ? 0 : 1);
