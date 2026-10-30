import { query } from '../lib/db';
import { jobLogger } from '../lib/logger';
import { monthlyInterestCents } from '../domain/money';
import { sastMonthStart } from '../domain/dates';

const log = jobLogger('interest-run');

/**
 * The rate comes from the deposit_interest_rate table, which the landlord maintains, with the
 * environment variable only as a fallback for an install that has never set one. The table
 * existed and the README said it was the source, but this job still read the variable alone,
 * so the rate the landlord set was never the rate that was paid.
 */
async function annualRateFor(periodMonth: string): Promise<number> {
  const [row] = await query<{ annual_pct: string }>(
    `select annual_pct from deposit_interest_rate
      where effective_from <= $1::date
      order by effective_from desc limit 1`,
    [periodMonth],
  );
  if (row) return Number(row.annual_pct);
  return Number(process.env.DEPOSIT_INTEREST_ANNUAL_PCT ?? '5.5');
}

/** Once a month: post a month of interest on every held deposit.
    The tenant owns this money, so it is a ledger entry, never a recalculation at exit.

    The month is the Johannesburg month of the run, and the balance is what was held at its
    start, so a run on the 3rd (catching up a 1st the server missed) credits exactly what the
    run on the 1st would have, and nothing for a deposit that arrived on the 2nd.

    Idempotent through the partial unique (lease_id, period_month) on interest rows, so a
    duplicate delivery or a manual re-run after a partial failure cannot credit the same month
    twice. */
export const handler = async () => {
  const periodMonth = sastMonthStart();
  const annualPct = await annualRateFor(periodMonth);

  // Only deposits still held under a live lease. A settled lease keeps a residual balance
  // when the tenant owed more than the deposit; that is a debt, not money earning interest.
  const balances = await query<{ lease_id: string; balance: string }>(
    `select d.lease_id, sum(case d.entry_type
              when 'received' then d.amount_cents
              when 'interest' then d.amount_cents
              else -d.amount_cents end)::text as balance
       from deposit_ledger d
       join lease l on l.id = d.lease_id
      where l.status not in ('terminated', 'cancelled')
        and d.occurred_on < $1::date
      group by d.lease_id
     having sum(case d.entry_type
              when 'received' then d.amount_cents
              when 'interest' then d.amount_cents
              else -d.amount_cents end) > 0`,
    [periodMonth],
  );

  let posted = 0;
  let skipped = 0;
  for (const row of balances) {
    const interest = monthlyInterestCents(Number(row.balance), annualPct);
    if (interest <= 0) continue;
    const inserted = await query<{ id: string }>(
      // Dated the first of its month, whatever day it ran, so next month's balance counts it.
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, period_month, note, occurred_on)
       values ($1, 'interest', $2, $3, $4, $3)
       on conflict (lease_id, period_month) where entry_type = 'interest' do nothing
       returning id`,
      [row.lease_id, interest, periodMonth, `Interest at ${annualPct}% p.a.`],
    );
    if (inserted.length > 0) posted += 1;
    else skipped += 1;
  }
  log.info('Interest run complete.', { periodMonth, posted, skipped, annualPct });
  return { posted, skipped };
};
