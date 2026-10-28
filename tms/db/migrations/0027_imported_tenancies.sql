-- Tenancies that started before the landlord used Threshold. Without this, every current tenant
-- had to apply, be approved and sign again before their rent could be tracked.

-- A tenant brought in by the landlord may have no ID number or income on record. Applicants
-- who apply online still give both: the application schema requires them.
alter table applicant alter column id_number_enc drop not null;
alter table applicant alter column id_number_last4 drop not null;
alter table applicant alter column employment_status drop not null;

-- 'import' marks the paperwork as done elsewhere: no screening, no signing in the app.
alter table application add column source text not null default 'online'
  check (source in ('online', 'import'));
alter table lease add column source text not null default 'online'
  check (source in ('online', 'import'));

-- The date the stated rent took effect. Escalation counts anniversaries from here, so a lease
-- imported mid-way, at its current rent, is not escalated a second time for years already past.
-- Null means the lease start, as before.
alter table lease add column escalates_from date;

-- An imported tenant has no sign-in. The landlord invites them; the link sets a password and
-- attaches the account to their tenant record.
create table tenant_invite (
  id           uuid primary key default gen_random_uuid(),
  applicant_id uuid        not null references applicant (id) on delete cascade,
  lease_id     uuid        not null references lease (id) on delete cascade,
  email        text        not null,
  token_hash   text        not null unique,
  invited_by   text        not null,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_sub text,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create unique index tenant_invite_open on tenant_invite (lease_id)
  where accepted_at is null and revoked_at is null;
