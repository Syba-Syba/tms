-- Bank statement import. The landlord uploads the CSV or OFX their bank exports, and each
-- credit becomes a line to match against a lease. Suggestions are computed when the lines are
-- read, not stored, because what a lease owes changes as other payments land.
--
-- Statements overlap: this month's export repeats the last days of last month's. Each line
-- carries a fingerprint, unique per landlord, so importing the same credit twice records it once.

create table bank_import (
  id           uuid primary key default gen_random_uuid(),
  landlord_id  uuid        not null references landlord (id),
  file_name    text        not null,
  format       text        not null check (format in ('csv', 'ofx')),
  imported_by  text        not null,
  created_at   timestamptz not null default now()
);

create index bank_import_landlord_idx on bank_import (landlord_id, created_at desc);

create table bank_line (
  id           uuid primary key default gen_random_uuid(),
  import_id    uuid        not null references bank_import (id) on delete cascade,
  landlord_id  uuid        not null references landlord (id),
  posted_on    date        not null,
  amount_cents bigint      not null check (amount_cents > 0),
  description  text        not null,
  fingerprint  text        not null,
  status       text        not null default 'unmatched'
               check (status in ('unmatched', 'matched', 'ignored')),
  lease_id     uuid        references lease (id),
  resolved_by  text,
  resolved_at  timestamptz,
  unique (landlord_id, fingerprint),
  check (status <> 'matched' or lease_id is not null)
);

create index bank_line_import_idx on bank_line (import_id, posted_on);

alter table payment add column bank_line_id uuid references bank_line (id);
