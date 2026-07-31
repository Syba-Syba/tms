-- Phase 7: renewals, and the pro-rata that both lease boundaries were missing.
--
-- A renewal has to be signed before the current lease ends, which means two leases exist for
-- one unit at the same time. lease_one_active_per_unit blocked that outright, so a signed
-- renewal had nowhere to sit. A lease that is signed but has not started yet is now
-- 'scheduled': real, immutable, and not the live lease until its start date.

alter table lease drop constraint lease_status_check;
alter table lease add constraint lease_status_check check (status in
  ('draft', 'out_for_signature', 'scheduled', 'active', 'terminated', 'cancelled'));

alter table lease add column previous_lease_id uuid references lease (id);
create index lease_previous_idx on lease (previous_lease_id);

-- Exactly one live lease per unit, and at most one queued behind it.
drop index lease_one_active_per_unit;
create unique index lease_one_live_per_unit
  on lease (unit_id) where status in ('out_for_signature', 'active');
create unique index lease_one_scheduled_per_unit
  on lease (unit_id) where status = 'scheduled';

-- A part month must say which days it covers, or nobody can check the arithmetic.
alter table invoice add column covers_from date;
alter table invoice add column covers_to date;

create table renewal (
  id                   uuid primary key default gen_random_uuid(),
  lease_id             uuid        not null references lease (id),
  offered_on           date        not null default current_date,
  respond_by           date        not null,
  term_months          smallint    not null check (term_months between 1 and 60),
  new_start_date       date        not null,
  new_end_date         date        not null,
  new_rent_cents       bigint      not null check (new_rent_cents > 0),
  escalation_pct       numeric(5,2) not null default 0,
  deposit_top_up_cents bigint      not null default 0 check (deposit_top_up_cents >= 0),
  status               text        not null default 'offered'
                       check (status in ('offered', 'accepted', 'declined', 'withdrawn', 'lapsed')),
  decided_at           timestamptz,
  new_lease_id         uuid        references lease (id),
  created_at           timestamptz not null default now(),
  check (new_end_date > new_start_date),
  check (respond_by <= new_start_date)
);

-- One open offer per lease. Declined and lapsed offers stay for the record.
create unique index renewal_one_open_per_lease on renewal (lease_id) where status = 'offered';
create index renewal_lease_idx on renewal (lease_id, offered_on desc);
