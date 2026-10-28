-- POPIA. Three things the Act asks for and the system did not have:
--
--   consent      proof of what each person agreed to, which version, when and from where
--   requests     a way to ask for one's data to be erased, decided by the landlord, who is
--                the responsible party, with the reason recorded either way
--   retention    application paperwork of people who never became tenants is not kept forever
--
-- Erasure does not delete rows that money and leases hang off. It replaces the person's
-- details with placeholders and deletes their files, so the ledger still adds up.

create table consent (
  id          uuid primary key default gen_random_uuid(),
  person_sub  text        not null,
  kind        text        not null check (kind in ('privacy_notice', 'application_screening')),
  version     text        not null,
  accepted_at timestamptz not null default now(),
  ip_address  text,
  user_agent  text,
  -- The application a screening consent covers.
  subject_id  uuid
);

create index consent_person_idx on consent (person_sub, kind, accepted_at desc);

create table privacy_request (
  id           uuid primary key default gen_random_uuid(),
  person_sub   text        not null,
  kind         text        not null default 'erasure' check (kind in ('erasure')),
  status       text        not null default 'pending' check (status in ('pending', 'completed', 'refused')),
  note         text,
  response     text,
  created_at   timestamptz not null default now(),
  decided_by   text,
  decided_at   timestamptz,
  check (status <> 'refused' or response is not null)
);

-- One open request per person: asking twice should not queue twice.
create unique index privacy_request_one_open on privacy_request (person_sub) where status = 'pending';

alter table applicant add column erased_at timestamptz;
