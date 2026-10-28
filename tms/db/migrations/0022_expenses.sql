-- Expenses. Rates, levies, insurance and repairs were nowhere in the system, so it could say
-- what came in but never what a property earned. A landlord needs both at tax time: SARS taxes
-- rental income less the expenses of earning it.
--
-- An expense belongs to a landlord, and optionally to a property and a unit. A bond payment's
-- interest is deductible and its capital is not, so they are different categories.

create table expense (
  id            uuid primary key default gen_random_uuid(),
  landlord_id   uuid        not null references landlord (id),
  property_id   uuid        references property (id),
  unit_id       uuid        references unit (id),
  category      text        not null check (category in (
                  'rates', 'levies', 'insurance', 'repairs', 'utilities', 'bond_interest',
                  'agent_fees', 'bank_charges', 'legal', 'advertising', 'other')),
  description   text        not null,
  amount_cents  bigint      not null check (amount_cents > 0),
  incurred_on   date        not null,
  slip_s3_key   text        unique,
  created_by    text        not null,
  created_at    timestamptz not null default now(),
  check (unit_id is null or property_id is not null)
);

create index expense_landlord_idx on expense (landlord_id, incurred_on desc);
