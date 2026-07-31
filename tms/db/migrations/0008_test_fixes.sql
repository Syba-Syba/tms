-- Found by testing: the deposit ledger accepted negative amounts, so a mistyped receipt could
-- silently corrupt the balance the whole settlement is computed from. Every other money table
-- already had this guard; this one did not.
alter table deposit_ledger
  add constraint deposit_ledger_amount_positive check (amount_cents > 0);
