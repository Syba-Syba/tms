-- Phase 4: maintenance and complaints.
-- One event table doubles as the status timeline and the message thread, so the whole
-- history of a ticket, actions and words, reads as a single record in order.

create table contractor (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid        not null references landlord (id),
  name        text        not null,
  trade       text        not null,
  phone       text        not null,
  email       text,
  created_at  timestamptz not null default now(),
  unique (landlord_id, phone)
);

create table ticket (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid        not null references lease (id),
  category      text        not null check (category in
                ('plumbing', 'electrical', 'appliance', 'structural', 'pest', 'security', 'other')),
  severity      text        not null check (severity in ('emergency', 'urgent', 'routine')),
  title         text        not null,
  description   text        not null,
  status        text        not null default 'open'
                check (status in ('open', 'assigned', 'quote_pending', 'quote_approved',
                                  'in_progress', 'done', 'closed', 'cancelled')),
  target_by     timestamptz not null,
  contractor_id uuid        references contractor (id),
  quote_cents   bigint,
  quote_approved_at timestamptz,
  created_by    text        not null,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  closed_at     timestamptz,
  rating        smallint    check (rating between 1 and 5),
  rating_note   text
);

create index ticket_status_idx on ticket (status, target_by);
create index ticket_lease_idx on ticket (lease_id, created_at desc);

create table ticket_photo (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid        not null references ticket (id) on delete cascade,
  phase        text        not null check (phase in ('report', 'completion')),
  s3_key       text        not null,
  content_type text        not null,
  size_bytes   bigint      not null,
  uploaded_at  timestamptz not null default now()
);

create table ticket_event (
  id         bigserial primary key,
  ticket_id  uuid        not null references ticket (id) on delete cascade,
  at         timestamptz not null default now(),
  actor_role text        not null check (actor_role in ('tenant', 'landlord', 'system')),
  kind       text        not null check (kind in
             ('created', 'assigned', 'quote_added', 'quote_approved',
              'started', 'completed', 'closed', 'cancelled', 'comment')),
  note       text
);

create index ticket_event_idx on ticket_event (ticket_id, at);
