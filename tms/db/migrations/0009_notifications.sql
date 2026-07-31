-- Phase 6: notifications.
--
-- Written as an outbox. A notification row is inserted in the SAME transaction as the business
-- event that caused it, and a scheduled worker sends it afterwards. That gives two properties
-- worth the extra table: a rolled back transaction can never send a message about something
-- that did not happen, and a failed send never loses the message.

create table notification_preference (
  person_sub  text        not null,
  category    text        not null check (category in
              ('money', 'maintenance', 'inspection', 'lease', 'deadline')),
  channel     text        not null check (channel in ('email', 'whatsapp', 'push')),
  enabled     boolean     not null default true,
  updated_at  timestamptz not null default now(),
  primary key (person_sub, category, channel)
);

create table notification (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid        references lease (id),
  recipient_sub text        not null,
  recipient_to  text        not null,
  channel       text        not null check (channel in ('email', 'whatsapp', 'push')),
  category      text        not null check (category in
                ('money', 'maintenance', 'inspection', 'lease', 'deadline')),
  kind          text        not null,
  urgent        boolean     not null default false,
  subject       text        not null,
  body          text        not null,
  -- Anything a sweep can raise more than once carries a key so it is only ever sent once.
  dedupe_key    text,
  status        text        not null default 'pending'
                check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts      smallint    not null default 0,
  send_after    timestamptz not null default now(),
  sent_at       timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);

-- The partial index is what makes a daily sweep safe to run as often as you like.
create unique index notification_dedupe on notification (dedupe_key) where dedupe_key is not null;
create index notification_due on notification (status, send_after) where status = 'pending';
create index notification_lease_idx on notification (lease_id, created_at desc);

-- The interest rate was a single environment variable, so changing it silently rewrote what
-- every past month should have earned. Rates now have effective dates and history.
create table deposit_interest_rate (
  id            uuid primary key default gen_random_uuid(),
  annual_pct    numeric(5,3) not null check (annual_pct >= 0),
  effective_from date        not null unique,
  created_at    timestamptz  not null default now()
);

insert into deposit_interest_rate (annual_pct, effective_from) values (5.500, '2020-01-01');
