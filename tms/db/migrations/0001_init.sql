-- Phase 1: one landlord, own units. Onboarding and lease signing only.
-- gen_random_uuid() is core Postgres from 13 onward, so no extension is needed. Requiring
-- pgcrypto here would have forced the migration user to hold rds_superuser for nothing.

create table landlord (
  id              uuid primary key default gen_random_uuid(),
  trading_name    text        not null,
  email           text        not null,
  phone           text        not null,
  created_at      timestamptz not null default now()
);

create table property (
  id              uuid primary key default gen_random_uuid(),
  landlord_id     uuid        not null references landlord (id),
  name            text        not null,
  address_line1   text        not null,
  suburb          text        not null,
  city            text        not null,
  province        text        not null,
  postal_code     text        not null,
  created_at      timestamptz not null default now()
);

create table unit (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid        not null references property (id),
  code              text        not null,
  bedrooms          smallint    not null,
  bathrooms         smallint    not null,
  monthly_rent_cents  bigint    not null check (monthly_rent_cents > 0),
  deposit_cents       bigint    not null check (deposit_cents >= 0),
  status            text        not null default 'vacant'
                    check (status in ('vacant', 'held', 'occupied')),
  created_at        timestamptz not null default now(),
  unique (property_id, code)
);

-- PoPIA: the ID number is encrypted with a KMS derived key. Only the last four digits are readable.
create table applicant (
  id                  uuid primary key default gen_random_uuid(),
  cognito_sub         text        unique,
  first_name          text        not null,
  last_name           text        not null,
  id_number_enc       bytea       not null,
  id_number_last4     char(4)     not null,
  email               text        not null,
  phone               text        not null,
  employment_status   text        not null
                      check (employment_status in ('employed', 'self_employed', 'contract', 'unemployed', 'retired')),
  employer            text,
  monthly_income_cents bigint     not null check (monthly_income_cents >= 0),
  created_at          timestamptz not null default now()
);

create table application (
  id              uuid primary key default gen_random_uuid(),
  unit_id         uuid        not null references unit (id),
  applicant_id    uuid        not null references applicant (id),
  status          text        not null default 'draft'
                  check (status in ('draft', 'submitted', 'screening', 'approved', 'declined', 'withdrawn')),
  occupants       smallint    not null default 1 check (occupants > 0),
  preferred_move_in date      not null,
  pets            boolean     not null default false,
  notes           text,
  submitted_at    timestamptz,
  decided_at      timestamptz,
  decided_by      text,
  decline_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index application_status_idx on application (status, submitted_at desc);
create index application_unit_idx on application (unit_id);

create table application_document (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid        not null references application (id) on delete cascade,
  kind            text        not null
                  check (kind in ('id_copy', 'payslip', 'bank_statement', 'proof_of_address', 'other')),
  s3_key          text        not null,
  content_type    text        not null,
  size_bytes      bigint      not null,
  uploaded_at     timestamptz not null default now(),
  verified_at     timestamptz,
  verified_by     text
);

create index application_document_app_idx on application_document (application_id);

create table lease (
  id                  uuid primary key default gen_random_uuid(),
  application_id      uuid        not null references application (id),
  unit_id             uuid        not null references unit (id),
  applicant_id        uuid        not null references applicant (id),
  start_date          date        not null,
  end_date            date        not null,
  monthly_rent_cents  bigint      not null check (monthly_rent_cents > 0),
  escalation_pct      numeric(5,2) not null default 0,
  deposit_cents       bigint      not null check (deposit_cents >= 0),
  status              text        not null default 'draft'
                      check (status in ('draft', 'out_for_signature', 'active', 'terminated', 'cancelled')),
  pdf_s3_key          text,
  pdf_sha256          text,
  created_at          timestamptz not null default now(),
  activated_at        timestamptz,
  check (end_date > start_date)
);

-- A unit can only carry one live lease at a time.
create unique index lease_one_active_per_unit
  on lease (unit_id)
  where status in ('out_for_signature', 'active');

create table lease_signature (
  id              uuid primary key default gen_random_uuid(),
  lease_id        uuid        not null references lease (id) on delete cascade,
  party           text        not null check (party in ('tenant', 'landlord')),
  signed_at       timestamptz not null default now(),
  signature_s3_key text       not null,
  otp_verified    boolean     not null default false,
  ip_address      inet,
  user_agent      text,
  pdf_sha256      text        not null,
  unique (lease_id, party)
);

-- The deposit is a ledger because the interest earned belongs to the tenant.
create table deposit_ledger (
  id              uuid primary key default gen_random_uuid(),
  lease_id        uuid        not null references lease (id),
  entry_type      text        not null
                  check (entry_type in ('received', 'interest', 'deduction', 'refund')),
  amount_cents    bigint      not null,
  occurred_on     date        not null default current_date,
  note            text,
  created_at      timestamptz not null default now()
);

create index deposit_ledger_lease_idx on deposit_ledger (lease_id, occurred_on);

create table audit_log (
  id          bigserial primary key,
  actor_sub   text,
  actor_role  text,
  action      text        not null,
  entity      text        not null,
  entity_id   uuid,
  detail      jsonb,
  at          timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity, entity_id, at desc);
