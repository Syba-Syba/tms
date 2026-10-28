-- Landlords agree to the terms of service, recorded like the privacy notice: which version,
-- when, from where.
alter table consent drop constraint consent_kind_check;
alter table consent add constraint consent_kind_check
  check (kind in ('privacy_notice', 'application_screening', 'terms_of_service'));

-- A landlord registered for VAT puts its number on its account; it prints on their invoices
-- from Threshold so they can claim the input tax.
alter table landlord add column vat_no text check (vat_no ~ '^4[0-9]{9}$');

-- What a landlord paid Threshold, as a numbered invoice. A tax invoice when the operator is
-- registered for VAT. The parties are copied in as they were on the day: an invoice does not
-- change when an address does.
create sequence billing_invoice_no_seq start 1001;

create table billing_invoice (
  id               uuid primary key default gen_random_uuid(),
  number           bigint      not null unique default nextval('billing_invoice_no_seq'),
  landlord_id      uuid        not null references landlord (id),
  billing_event_id uuid        not null unique references billing_event (id),
  issued_on        date        not null,
  period_from      date        not null,
  period_to        date        not null,
  plan             text        not null,
  amount_cents     bigint      not null check (amount_cents > 0),
  vat_cents        bigint      not null check (vat_cents >= 0),
  supplier         jsonb       not null,
  recipient        jsonb       not null,
  pdf_s3_key       text,
  created_at       timestamptz not null default now()
);

create index billing_invoice_landlord on billing_invoice (landlord_id, issued_on desc);
