-- The monthly interest run had nothing making it idempotent. The invoice run guards itself
-- with a unique (lease_id, period_start) and an `on conflict do nothing`; the interest run
-- simply inserted a row per lease per invocation.
--
-- EventBridge schedules are at-least-once, so a duplicate invocation credits every held
-- deposit twice. So does a manual re-run after the loop fails partway, because the leases it
-- already processed are not skipped. The deposit and its interest are the tenant's money under
-- the Rental Housing Act, so this corrupts a balance the exit settlement is then computed from.
--
-- The fix is the same shape the invoice run already uses: name the period, then make it unique.

alter table deposit_ledger add column period_month date;

-- Existing interest rows are stamped with the month they landed in.
update deposit_ledger
   set period_month = date_trunc('month', occurred_on)::date
 where entry_type = 'interest';

-- Any deposit credited twice for one month was credited so by the bug above, never by an
-- operator. The earliest entry of each month is the real one; the rest are duplicates and are
-- removed so the balance matches what the tenant is actually owed.
delete from deposit_ledger
 where entry_type = 'interest'
   and id not in (
     select distinct on (lease_id, period_month) id
       from deposit_ledger
      where entry_type = 'interest'
      order by lease_id, period_month, created_at, id
   );

-- One interest posting per lease per month, enforced by the database rather than by the job
-- remembering to check.
create unique index deposit_ledger_interest_month_idx
    on deposit_ledger (lease_id, period_month)
 where entry_type = 'interest';

-- An interest row without a month would slip past the index above.
alter table deposit_ledger
  add constraint deposit_ledger_interest_has_month
  check (entry_type <> 'interest' or period_month is not null);
