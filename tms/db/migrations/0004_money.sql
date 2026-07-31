-- Phase 3: money. Invoices, payments, arrears, deposit interest.
-- Payment capture is manual EFT first: one landlord, a few units, zero gateway fees.
-- The payment table carries method and an external reference so a gateway can slot in later
-- without a migration.

create table invoice (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid        not null references lease (id),
  period_start  date        not null,
  due_on        date        not null,
  total_cents   bigint      not null check (total_cents >= 0),
  status        text        not null default 'issued'
                check (status in ('issued', 'part_paid', 'paid', 'void')),
  issued_at     timestamptz not null default now(),
  pdf_s3_key    text,
  unique (lease_id, period_start)
);

create index invoice_lease_idx on invoice (lease_id, period_start desc);

create table invoice_line (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid   not null references invoice (id) on delete cascade,
  kind        text   not null check (kind in ('rent', 'utility', 'other')),
  description text   not null,
  amount_cents bigint not null
);

create table payment (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid        not null references lease (id),
  invoice_id    uuid        references invoice (id),
  amount_cents  bigint      not null check (amount_cents > 0),
  method        text        not null check (method in ('eft', 'cash', 'gateway')),
  reference     text,
  received_on   date        not null,
  recorded_by   text        not null,
  created_at    timestamptz not null default now()
);

create index payment_invoice_idx on payment (invoice_id);
create index payment_lease_idx on payment (lease_id, received_on desc);
