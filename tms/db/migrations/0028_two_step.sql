-- Two-step sign-in for the local auth driver: a code from an authenticator app after the
-- password. Cognito brings its own MFA in aws mode.
--
-- A landlord's bank account is what a thief changes to collect the rent, and the password is
-- all that stands in the way. Changing a bank account already on file now needs a current code.

alter table local_credential add column totp_secret_enc bytea;
alter table local_credential add column totp_enabled_at timestamptz;
-- The last 30-second step a code was accepted for, so a code seen over a shoulder cannot be
-- used a second time.
alter table local_credential add column totp_last_step bigint;

-- For a lost phone. Ten single-use codes, shown once when two-step is turned on, kept hashed.
create table recovery_code (
  sub        text        not null references local_credential (sub) on delete cascade,
  code_hash  text        not null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  primary key (sub, code_hash)
);
