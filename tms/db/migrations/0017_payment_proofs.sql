-- Proof of payment. A tenant who paid by EFT uploads the bank's slip; the landlord checks it
-- against the account and accepts or rejects it. Until then the rent shows as "proof sent"
-- rather than overdue, and the overdue reminder holds off.
--
-- Accepting does not trust the slip's numbers: the landlord confirms the amount, and the
-- payment rows it creates are ordinary payments with a link back here.

create table payment_proof (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid        not null references lease (id),
  target        text        not null check (target in ('invoice', 'deposit')),
  invoice_id    uuid        references invoice (id),
  amount_cents  bigint      not null check (amount_cents > 0),
  paid_on       date        not null,
  reference     text,
  s3_key        text        not null unique,
  content_type  text        not null,
  size_bytes    integer     not null check (size_bytes > 0),
  status        text        not null default 'uploading'
                check (status in ('uploading', 'pending', 'accepted', 'rejected')),
  submitted_by  text        not null,
  submitted_at  timestamptz,
  reviewed_by   text,
  reviewed_at   timestamptz,
  reject_reason text,
  created_at    timestamptz not null default now(),
  check (target = 'invoice' or invoice_id is null),
  check (status <> 'rejected' or reject_reason is not null)
);

create index payment_proof_lease_idx on payment_proof (lease_id, created_at desc);
create index payment_proof_pending_idx on payment_proof (status) where status = 'pending';

-- Where a payment came from, so a statement line can be traced back to its slip.
alter table payment add column proof_id uuid references payment_proof (id);
