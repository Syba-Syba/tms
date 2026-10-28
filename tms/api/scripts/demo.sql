-- Demo data on top of the development seed: what a small landlord's account looks like a few
-- months in. Dates are relative to today, so the dashboard reads the same whenever it is run.
-- Applied by `npm run demo`, never by the migration runner and never by the tests.

-- Naledi at Kruis Court A1: three months of rent, all paid on time.
insert into invoice (lease_id, period_start, due_on, total_cents, status)
select '66666666-6666-6666-6666-666666666666', m, m + 6, 850000, 'paid'
  from generate_series(date_trunc('month', current_date) - interval '2 months',
                       date_trunc('month', current_date), interval '1 month') as g(m0),
       lateral (select m0::date as m) as d
on conflict do nothing;

insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
select i.lease_id, i.id, i.total_cents, 'eft', 'LSE-00101', i.due_on - 2, 'sub-landlord'
  from invoice i
 where i.lease_id = '66666666-6666-6666-6666-666666666666' and i.status = 'paid'
   and not exists (select 1 from payment p where p.invoice_id = i.id);

-- A second building with two tenants and a vacancy.
insert into property (id, landlord_id, name, address_line1, suburb, city, province, postal_code)
values ('d0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
        'Melville Gardens', '7 Seventh Street', 'Melville', 'Johannesburg', 'Gauteng', '2092');

insert into unit (id, property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
values
  ('d0000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000001', 'G1', 1, 1, 780000, 780000, 'occupied'),
  ('d0000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000001', 'G2', 2, 1, 950000, 950000, 'occupied'),
  ('d0000000-0000-0000-0000-000000000013', 'd0000000-0000-0000-0000-000000000001', 'F1', 2, 2, 1050000, 1050000, 'vacant');

insert into applicant (id, first_name, last_name, id_number_enc, id_number_last4, email, phone,
                       employment_status, monthly_income_cents)
values
  ('d0000000-0000-0000-0000-000000000021', 'Thandi', 'Dlamini', '\x00', '4412', 'thandi@example.co.za',
   '+27825550101', 'employed', 2600000),
  ('d0000000-0000-0000-0000-000000000022', 'Kabelo', 'Mokoena', '\x00', '7731', 'kabelo@example.co.za',
   '+27825550102', 'self_employed', 3400000);

insert into application (id, unit_id, applicant_id, status, preferred_move_in)
values
  ('d0000000-0000-0000-0000-000000000031', 'd0000000-0000-0000-0000-000000000011',
   'd0000000-0000-0000-0000-000000000021', 'approved', current_date - 300),
  ('d0000000-0000-0000-0000-000000000032', 'd0000000-0000-0000-0000-000000000012',
   'd0000000-0000-0000-0000-000000000022', 'approved', current_date - 320);

-- Thandi's lease runs well into next year; Kabelo's ends in six weeks, so renewal comes up.
insert into lease (id, application_id, unit_id, applicant_id, start_date, end_date,
                   monthly_rent_cents, escalation_pct, deposit_cents, status, activated_at)
values
  ('d0000000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000031',
   'd0000000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000021',
   current_date - 300, current_date + 65, 780000, 8, 780000, 'active', now() - interval '300 days'),
  ('d0000000-0000-0000-0000-000000000042', 'd0000000-0000-0000-0000-000000000032',
   'd0000000-0000-0000-0000-000000000012', 'd0000000-0000-0000-0000-000000000022',
   current_date - 320, current_date + 42, 950000, 8, 950000, 'active', now() - interval '320 days');

insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
values
  ('d0000000-0000-0000-0000-000000000041', 'received', 780000, current_date - 300, 'Paid before move in'),
  ('d0000000-0000-0000-0000-000000000042', 'received', 950000, current_date - 320, 'Paid before move in');

-- Three months each. Thandi is a month behind; Kabelo is paid up.
insert into invoice (lease_id, period_start, due_on, total_cents, status)
select l.id, m, m + 6, l.monthly_rent_cents,
       case when l.id = 'd0000000-0000-0000-0000-000000000041' and m >= date_trunc('month', current_date - 31)::date
            then 'issued'
            else 'paid' end
  from lease l,
       generate_series(date_trunc('month', current_date) - interval '2 months',
                       date_trunc('month', current_date), interval '1 month') as g(m0),
       lateral (select m0::date as m) as d
 where l.id in ('d0000000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000042');

insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
select i.lease_id, i.id, i.total_cents, 'eft', 'LSE-' || lpad(l.ref_no::text, 5, '0'), i.due_on - 1, 'sub-landlord'
  from invoice i join lease l on l.id = i.lease_id
 where i.lease_id in ('d0000000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000042')
   and i.status = 'paid';

-- A burst geyser at G1, past its response target.
insert into ticket (lease_id, category, severity, title, description, status, target_by, created_by, created_at)
values ('d0000000-0000-0000-0000-000000000041', 'plumbing', 'urgent', 'Geyser leaking through the ceiling',
        'Water coming through the bathroom ceiling since this morning. Geyser switched off at the board.',
        'open', now() - interval '3 hours', 'sub-landlord', now() - interval '27 hours');

-- The costs of running both buildings this tax year.
insert into expense (landlord_id, property_id, category, description, amount_cents, incurred_on, created_by)
select '11111111-1111-1111-1111-111111111111', p, c, d, a, current_date - o, 'sub-landlord'
  from (values
    ('22222222-2222-2222-2222-222222222222'::uuid, 'rates', 'City of Joburg rates and taxes', 145000, 40),
    ('22222222-2222-2222-2222-222222222222'::uuid, 'rates', 'City of Joburg rates and taxes', 145000, 10),
    ('22222222-2222-2222-2222-222222222222'::uuid, 'insurance', 'Building insurance, annual', 960000, 70),
    ('d0000000-0000-0000-0000-000000000001'::uuid, 'levies', 'Body corporate levy', 210000, 35),
    ('d0000000-0000-0000-0000-000000000001'::uuid, 'levies', 'Body corporate levy', 210000, 5),
    ('d0000000-0000-0000-0000-000000000001'::uuid, 'repairs', 'Replaced G2 stove plate', 85000, 20),
    ('d0000000-0000-0000-0000-000000000001'::uuid, 'bond_interest', 'Bond interest, Standard Bank', 640000, 15)
  ) as e(p, c, d, a, o);

insert into expense (landlord_id, category, description, amount_cents, incurred_on, created_by)
values ('11111111-1111-1111-1111-111111111111', 'bank_charges', 'Business account fees', 18500, current_date - 3, 'sub-landlord');
