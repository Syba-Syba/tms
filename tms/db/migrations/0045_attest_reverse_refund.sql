-- 1. A notice the landlord recorded and the tenant never confirmed could not be settled. The
--    landlord may now attach the tenant's written notice and attest to it. The attestation and
--    its evidence are kept on the notice; tenant_confirmed_at is set too, so everything that
--    asks "is this notice in force" keeps one test.
alter table termination
  add column attested_at            timestamptz,
  add column attested_by            text,
  add column attestation_statement  text,
  add column evidence_s3_key        text,
  -- 2. Settlement says what refund is due and by when. These record that it was actually paid.
  add column refund_paid_on           date,
  add column refund_paid_reference    text,
  add column refund_paid_recorded_by  text,
  add column refund_paid_recorded_at  timestamptz;

-- An upload link for a written notice, before any notice row holds its key. The uploads sweep
-- deletes the object and the entry after an hour if no notice took it up. No foreign key, as
-- for pending_upload: the entry must outlive its lease long enough to be swept.
create table notice_evidence (
  s3_key      text        primary key,
  lease_id    uuid        not null,
  created_by  text        not null,
  created_at  timestamptz not null default now()
);
create index notice_evidence_lease_idx on notice_evidence (lease_id, created_at);

-- 3. A payment recorded on the wrong lease, or with the wrong amount or date, could not be
--    corrected. A reversal is a negative payment against the same invoice that points at the
--    payment it undoes; one payment is reversed at most once.
alter table payment
  add column reverses_payment_id uuid references payment (id),
  add column reversal_reason     text;
create unique index payment_reversal_idx on payment (reverses_payment_id) where reverses_payment_id is not null;

alter table payment drop constraint payment_method_check;
alter table payment drop constraint payment_amount_cents_check;
alter table payment add constraint payment_method_check
  check (method in ('eft', 'cash', 'gateway', 'deposit', 'refund', 'reversal'));
alter table payment add constraint payment_amount_cents_check
  check ((method in ('refund', 'reversal') and amount_cents < 0)
      or (method not in ('refund', 'reversal') and amount_cents > 0));
alter table payment add constraint payment_reversal_check
  check ((method = 'reversal') = (reverses_payment_id is not null));
