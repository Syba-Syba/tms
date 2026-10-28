-- Development seed only. The seeded landlord gets a listings link and bank details, so the
-- rent screen and invoices show what a real account shows.
update landlord
   set slug = 'mokoena-properties',
       bank_name = 'FNB',
       bank_account_holder = 'Mokoena Properties',
       bank_account_number = '62812345678',
       bank_branch_code = '250655'
 where id = '11111111-1111-1111-1111-111111111111';
