-- Phase 2: move-in and move-out inspections.
-- Rental Housing Act: the parties must jointly inspect before move-in and attach a defects
-- list to the lease. The outgoing inspection happens in the final 3 days of the lease, in the
-- tenant's presence. A landlord who skips it is deemed to acknowledge no damage, which kills
-- deposit deductions. These rules shape the schema below.

create table inspection (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid        not null references lease (id),
  kind          text        not null check (kind in ('incoming', 'outgoing')),
  status        text        not null default 'in_progress'
                check (status in ('in_progress', 'awaiting_signatures', 'completed', 'missed')),
  scheduled_for date        not null,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  pdf_s3_key    text,
  pdf_sha256    text,
  created_at    timestamptz not null default now(),
  unique (lease_id, kind)
);

-- One row per room + item. The outgoing inspection compares against the incoming one on the
-- same (room, item) key, so the delta is a join, not a guess.
create table inspection_finding (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid        not null references inspection (id) on delete cascade,
  room          text        not null,
  item          text        not null,
  condition     text        not null default 'good'
                check (condition in ('good', 'fair', 'poor', 'damaged', 'missing')),
  note          text,
  updated_at    timestamptz not null default now(),
  unique (inspection_id, room, item)
);

create index inspection_finding_idx on inspection_finding (inspection_id, room);

create table inspection_photo (
  id            uuid primary key default gen_random_uuid(),
  finding_id    uuid        not null references inspection_finding (id) on delete cascade,
  s3_key        text        not null,
  content_type  text        not null,
  size_bytes    bigint      not null,
  uploaded_at   timestamptz not null default now()
);

create table inspection_signature (
  id                uuid primary key default gen_random_uuid(),
  inspection_id     uuid        not null references inspection (id) on delete cascade,
  party             text        not null check (party in ('tenant', 'landlord')),
  signed_at         timestamptz not null default now(),
  signature_s3_key  text        not null,
  pdf_sha256        text        not null,
  ip_address        inet,
  user_agent        text,
  unique (inspection_id, party)
);
