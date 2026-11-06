-- A renewal that starts mid-month merges the old lease's rent for that month into the
-- renewal's invoice. It was stored as 'other', which the lease screen lists as a charge and
-- lets the landlord delete. It is rent, from the lease before.
alter table invoice_line drop constraint invoice_line_kind_check;
alter table invoice_line add constraint invoice_line_kind_check
  check (kind in ('rent', 'prior_rent', 'utility', 'other'));

update invoice_line il set kind = 'prior_rent'
  from invoice i, lease l
 where i.id = il.invoice_id and l.id = i.lease_id and l.previous_lease_id is not null
   and il.kind = 'other' and il.description like 'Rent · %';
