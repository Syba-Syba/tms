-- Credentials for the local auth driver only. Production identity is Cognito, checked by the
-- API Gateway authorizer before any handler runs; this table sits empty there.
create table local_credential (
  sub           text        primary key,
  email         text        not null unique,
  name          text        not null,
  role          text        not null check (role in ('landlord', 'tenant')),
  password_hash text        not null,
  created_at    timestamptz not null default now()
);
