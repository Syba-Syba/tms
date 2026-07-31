import { query } from '../lib/db';
import { monthlyInterestCents } from '../domain/money';

const ANNUAL_PCT = Number(process.env.DEPOSIT_INTEREST_ANNUAL_PCT ?? '5.5');

/** EventBridge, first of the month: post a month of interest on every held deposit.
    The tenant owns this money, so it is a ledger entry, never a recalculation at exit. */
export const handler = async () => {
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
  for (const row of balances) {
    const interest = monthlyInterestCents(Number(row.balance), ANNUAL_PCT);
    if (interest <= 0) continue;
    await query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, note)
       values ($1, 'interest', $2, $3)`,
      [row.lease_id, interest, `Interest at ${ANNUAL_PCT}% p.a.`],
    );
    posted += 1;
  }
  console.log(JSON.stringify({ message: 'Interest run complete.', posted, annualPct: ANNUAL_PCT }));
  return { posted };
};
