-- Charges on top of rent: water, electricity, levies, a replaced key. The invoice already had
-- line kinds for them, but nothing put any on it.
--
-- A charge for a month whose invoice exists goes straight onto it. One for a month not billed
-- yet waits here, and the monthly run adds it to that month's invoice when it issues it.
create table pending_charge (
  id           uuid primary key default gen_random_uuid(),
  lease_id     uuid        not null references lease (id) on delete cascade,
  period_start date        not null check (extract(day from period_start) = 1),
  kind         text        not null check (kind in ('utility', 'other')),
  description  text        not null,
  amount_cents bigint      not null check (amount_cents > 0),
  added_by     text        not null,
  created_at   timestamptz not null default now()
);

create index pending_charge_due on pending_charge (lease_id, period_start);
