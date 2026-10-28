-- Arrears. Unpaid rent used to get one reminder on day 3 and then one a week, forever, with
-- nothing recorded and no next step. Now each spell of arrears on a lease is a case, and each
-- step taken on it is a row: reminders on days 1, 3 and 7, then a letter of demand the
-- landlord sends. The case closes by itself once nothing due is owed.
--
-- The rows are the record a landlord needs if a tenancy ends at the Rental Housing Tribunal or
-- in court: what was owed, when the tenant was told, and when they were given to remedy it.

create table arrears_case (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid        not null references lease (id),
  opened_on     date        not null,
  closed_on     date,
  -- A payment plan or a dispute: reminders hold until this date. Never the letter's deadline.
  paused_until  date,
  pause_reason  text,
  paused_by     text,
  created_at    timestamptz not null default now(),
  check (paused_until is null or pause_reason is not null)
);

-- One open case per lease.
create unique index arrears_case_open on arrears_case (lease_id) where closed_on is null;

create table arrears_step (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid        not null references arrears_case (id) on delete cascade,
  step              text        not null
                    check (step in ('reminder_1', 'reminder_3', 'reminder_7', 'letter_of_demand')),
  taken_on          date        not null,
  days_late         integer     not null,
  outstanding_cents bigint      not null check (outstanding_cents > 0),
  -- The letter's deadline to pay, in business days.
  remedy_by         date,
  document_s3_key   text        unique,
  taken_by          text        not null,
  created_at        timestamptz not null default now(),
  unique (case_id, step),
  check (step <> 'letter_of_demand' or (remedy_by is not null and document_s3_key is not null))
);
