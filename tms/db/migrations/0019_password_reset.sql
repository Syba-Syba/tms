-- Self-hosted sign-in had no way back from a forgotten password. Cognito brings one in aws
-- mode; this is the local driver's equivalent.
--
-- Only a SHA-256 of the token is stored. The token itself travels once, in an email, so a
-- copy of this table cannot be used to take over an account.

create table password_reset (
  id          uuid primary key default gen_random_uuid(),
  sub         text        not null references local_credential (sub) on delete cascade,
  token_hash  text        not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index password_reset_sub_idx on password_reset (sub, created_at desc);

-- Account email is not a lease matter and cannot be switched off, so it gets its own category
-- on the outbox. It is deliberately absent from notification_preference: there is nothing to
-- opt out of.
alter table notification drop constraint notification_category_check;
alter table notification add constraint notification_category_check
  check (category in ('money', 'maintenance', 'inspection', 'lease', 'deadline', 'account'));
