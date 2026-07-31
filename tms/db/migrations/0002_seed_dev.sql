-- Development seed only. Never run against production.
--
-- The migration runner skips any file with "seed" in the name, so this is applied by hand:
--   psql tms -f ../../db/migrations/0002_seed_dev.sql
--
-- The Cognito subs below match what src/local.ts fakes, so the local API recognises you as
-- the landlord and the seeded tenant without anyone signing in. Authorization checks that you
-- are the landlord of this specific property, not merely that you claim to be a landlord, so
-- a landlord row without cognito_sub locks you out of your own data.

insert into landlord (id, trading_name, email, phone, cognito_sub)
values ('11111111-1111-1111-1111-111111111111', 'Mokoena Properties',
        'owner@example.co.za', '+27821234567', 'sub-landlord');

insert into property (id, landlord_id, name, address_line1, suburb, city, province, postal_code)
values
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   'Kruis Court', '14 Kruis Avenue', 'Ferndale', 'Randburg', 'Gauteng', '2194');

insert into unit (id, property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
values
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222',
   'A1', 2, 1, 850000, 850000, 'occupied'),
  ('33333333-3333-3333-3333-333333333334', '22222222-2222-2222-2222-222222222222',
   'A2', 1, 1, 620000, 620000, 'vacant'),
  ('33333333-3333-3333-3333-333333333335', '22222222-2222-2222-2222-222222222222',
   'B1', 3, 2, 1140000, 1710000, 'vacant');

-- A tenant already in place, so the money, maintenance and inspection routes have something
-- to return instead of an empty list.
insert into applicant (id, cognito_sub, first_name, last_name, id_number_enc, id_number_last4,
                       email, phone, employment_status, monthly_income_cents)
values ('44444444-4444-4444-4444-444444444444', 'sub-tenant', 'Naledi', 'Phiri',
        '\x00', '0086', 'naledi@example.co.za', '+27823419922', 'employed', 3100000);

insert into application (id, unit_id, applicant_id, status, preferred_move_in)
values ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444', 'approved', current_date - 200);

insert into lease (id, application_id, unit_id, applicant_id, start_date, end_date,
                   monthly_rent_cents, escalation_pct, deposit_cents, status)
values ('66666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555',
        '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
        current_date - 200, current_date + 165, 850000, 8, 850000, 'active');

insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
values ('66666666-6666-6666-6666-666666666666', 'received', 850000, current_date - 200,
        'Paid before move in');

-- A second applicant waiting on a decision, so the landlord queue is not empty either.
insert into applicant (id, cognito_sub, first_name, last_name, id_number_enc, id_number_last4,
                       email, phone, employment_status, monthly_income_cents)
values ('44444444-4444-4444-4444-444444444445', 'sub-applicant', 'Sipho', 'Mahlangu',
        '\x00', '0091', 'sipho@example.co.za', '+27824567788', 'contract', 1900000);

insert into application (unit_id, applicant_id, status, submitted_at, preferred_move_in)
values ('33333333-3333-3333-3333-333333333334', '44444444-4444-4444-4444-444444444445',
        'submitted', now() - interval '2 days', current_date + 30);
