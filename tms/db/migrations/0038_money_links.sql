-- A deposit slip accepted before its bank line arrives: the line is matched to the slip and
-- records nothing new. Without a link, the line was allocated as rent and the one transfer
-- counted twice. The ledger row also says which slip or bank line put it there.
alter table bank_line add column proof_id uuid references payment_proof (id);
alter table deposit_ledger add column proof_id uuid references payment_proof (id);
alter table deposit_ledger add column bank_line_id uuid references bank_line (id);

-- A plan change waits here until the payment at its price arrives. Setting the plan at once
-- raised the unit allowance on an upgrade nobody had paid for.
alter table subscription add column pending_plan text check (pending_plan in ('starter', 'standard', 'pro'));
