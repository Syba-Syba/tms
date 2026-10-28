-- Arrears taken from the deposit at settlement were posted to the deposit ledger but never
-- against the invoices they covered, so the statement still showed the tenant owing them.
-- Settlement now records that money as a payment on each invoice, with its own method so it
-- is never mistaken for money the tenant paid in.

alter table payment drop constraint payment_method_check;
alter table payment add constraint payment_method_check
  check (method in ('eft', 'cash', 'gateway', 'deposit'));
