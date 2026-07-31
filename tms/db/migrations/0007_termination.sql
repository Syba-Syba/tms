-- Phase 5: termination, deposit reconciliation, refund, archive.
--
-- Two different clocks run here and they are not the same unit.
--   Notice periods are BUSINESS days (Consumer Protection Act s14: 20 business days).
--   Refund deadlines are CALENDAR days (Rental Housing Act s5(3): 7, 14 or 21).
-- Storing both the anchor date and the computed deadline keeps a settled lease auditable
-- even after the holiday calendar is corrected.

create table termination (
  id                uuid primary key default gen_random_uuid(),
  lease_id          uuid        not null references lease (id),
  initiated_by      text        not null check (initiated_by in ('tenant', 'landlord', 'mutual')),
  reason            text        not null check (reason in
                    ('end_of_term', 'early_tenant', 'breach_by_tenant', 'breach_by_landlord', 'mutual')),
  notice_given_on   date        not null,
  effective_on      date        not null,
  notice_days       smallint    not null,
  penalty_cents     bigint      not null default 0 check (penalty_cents >= 0),
  status            text        not null default 'notice_served'
                    check (status in ('notice_served', 'awaiting_inspection', 'reconciling',
                                      'settled', 'withdrawn')),
  -- Which deadline rule applies is decided at reconciliation, not at notice.
  refund_rule       text        check (refund_rule in ('no_deductions', 'with_deductions', 'no_inspection')),
  refund_anchor_on  date,
  refund_due_by     date,
  settled_at        timestamptz,
  statement_s3_key  text,
  statement_sha256  text,
  created_at        timestamptz not null default now(),
  unique (lease_id),
  check (effective_on >= notice_given_on)
);

-- Every deduction must point at the outgoing finding that justifies it. A deduction with no
-- finding behind it is the thing tenants win disputes over.
create table deposit_deduction (
  id              uuid primary key default gen_random_uuid(),
  termination_id  uuid        not null references termination (id) on delete cascade,
  finding_id      uuid        references inspection_finding (id),
  description     text        not null,
  amount_cents    bigint      not null check (amount_cents > 0),
  evidence_s3_key text,
  created_at      timestamptz not null default now()
);

create index deposit_deduction_termination_idx on deposit_deduction (termination_id);
