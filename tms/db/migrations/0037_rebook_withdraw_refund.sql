-- Workflow fixes: rebooking the exit inspection, withdrawing a notice, one deduction per
-- finding, and the rent credit refunded at settlement.

-- 1. One inspection of each kind per lease, among those still standing. When the end date
--    moves (a lease running month to month, then notice) the exit inspection booked for the
--    old date is marked 'missed' and a new one booked for the new final window. The full
--    unique constraint made that second booking fail with a 500.
alter table inspection drop constraint inspection_lease_id_kind_key;
create unique index inspection_one_live_per_kind
  on inspection (lease_id, kind) where status <> 'missed';

-- 2. A withdrawn notice no longer stands, so a new one can be served on the same lease.
alter table termination drop constraint termination_lease_id_key;
create unique index termination_one_live_per_lease
  on termination (lease_id) where status <> 'withdrawn';

-- 3. The same outgoing finding cannot be deducted twice from one deposit.
create unique index deposit_deduction_one_per_finding
  on deposit_deduction (termination_id, finding_id) where finding_id is not null;

-- 4. Rent paid above an invoice's total is the tenant's credit, refunded with the deposit at
--    settlement. The refund is recorded as a negative payment against the overpaid invoice, so
--    the rent statement balances to zero afterwards instead of showing the landlord still owing
--    it. Only a refund may be negative, and a refund is never positive.
alter table payment drop constraint payment_amount_cents_check;
alter table payment drop constraint payment_method_check;
alter table payment add constraint payment_method_check
  check (method in ('eft', 'cash', 'gateway', 'deposit', 'refund'));
alter table payment add constraint payment_amount_cents_check
  check ((method = 'refund' and amount_cents < 0) or (method <> 'refund' and amount_cents > 0));
