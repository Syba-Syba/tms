-- Development sign-ins for the seeded people. Password for all three: dev
insert into local_credential (sub, email, name, role, password_hash)
values
  ('sub-landlord',  'landlord@example.co.za', 'Mokoena Properties', 'landlord', 'plain:dev'),
  ('sub-tenant',    'naledi@example.co.za',   'Naledi Phiri',       'tenant',   'plain:dev'),
  ('sub-applicant', 'sipho@example.co.za',    'Sipho Mahlangu',     'tenant',   'plain:dev');
