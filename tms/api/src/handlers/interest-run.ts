import { query } from '../lib/db';
import { jobLogger } from '../lib/logger';
import { monthlyInterestCents } from '../domain/money';

const ANNUAL_PCT = Number(process.env.DEPOSIT_INTEREST_ANNUAL_PCT ?? '5.5');
const log = jobLogger('interest-run');

/** EventBridge, first of the month: post a month of interest on every held deposit.
    The tenant owns this money, so it is a ledger entry, never a recalculation at exit.

    Idempotent through the partial unique (lease_id, period_month) on interest rows, so a
    duplicate EventBridge delivery or a manual re-run after a partial failure cannot credit
    the same month twice. */
export const handler = async () => {
  const now = new Date();
  const periodMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);

  const balances = await query<{ lease_id: string; balance: string }>(
    `select lease_id, sum(case entry_type
              when 'received' then amount_cents
              when 'interest' then amount_cents
              else -amount_cents end)::text as balance
       from deposit_ledger
      group by lease_id
     having sum(case entry_type
              when 'received' then amount_cents
              when 'interest' then amount_cents
              else -amount_cents end) > 0`,
  );

  let posted = 0;
  let skipped = 0;
  for (const row of balances) {
    const interest = monthlyInterestCents(Number(row.balance), ANNUAL_PCT);
    if (interest <= 0) continue;
    const inserted = await query<{ id: string }>(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, period_month, note)
       values ($1, 'interest', $2, $3, $4)
       on conflict (lease_id, period_month) where entry_type = 'interest' do nothing
       returning id`,
      [row.lease_id, interest, periodMonth, `Interest at ${ANNUAL_PCT}% p.a.`],
    );
    if (inserted.length > 0) posted += 1;
    else skipped += 1;
  }
  log.info('Interest run complete.', { periodMonth, posted, skipped, annualPct: ANNUAL_PCT });
  return { posted, skipped };
};
