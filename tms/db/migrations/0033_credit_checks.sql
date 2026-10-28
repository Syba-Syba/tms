-- Credit checks. Threshold does not query a bureau itself: the landlord runs the check with their
-- own bureau or TPN account and records the result here, with the report attached. Only with
-- the applicant's agreement, which is kept like every other consent.

alter table consent drop constraint consent_kind_check;
alter table consent add constraint consent_kind_check
  check (kind in ('privacy_notice', 'application_screening', 'terms_of_service', 'credit_check'));

-- The bureau's report is filed with the applicant's other documents, so it is shown, exported,
-- swept and erased by the same rules.
alter table application_document drop constraint application_document_kind_check;
alter table application_document add constraint application_document_kind_check
  check (kind in ('id_copy', 'payslip', 'bank_statement', 'proof_of_address', 'other', 'credit_report'));

create table credit_check (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid        not null unique references application (id) on delete cascade,
  bureau         text        not null check (bureau in ('transunion', 'experian', 'xds', 'compuscan', 'tpn', 'other')),
  checked_on     date        not null,
  score          smallint    check (score between 0 and 999),
  outcome        text        not null check (outcome in ('clear', 'minor', 'adverse')),
  judgements     smallint    not null default 0 check (judgements between 0 and 99),
  defaults       smallint    not null default 0 check (defaults between 0 and 99),
  notes          text        check (notes is null or length(notes) <= 1000),
  document_id    uuid        references application_document (id) on delete set null,
  recorded_by    text        not null,
  recorded_at    timestamptz not null default now()
);
