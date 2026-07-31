-- Postgres does not index a foreign key just because it is one. These four columns sit in the
-- join that every authenticated request walks (lease to unit to property to landlord), so they
-- were being scanned on each call.
create index unit_property_idx on unit (property_id);
create index property_landlord_idx on property (landlord_id);
create index lease_applicant_idx on lease (applicant_id);
create index application_applicant_idx on application (applicant_id);

-- Read on every render of the document they belong to.
create index invoice_line_invoice_idx on invoice_line (invoice_id);
create index lease_signature_lease_idx on lease_signature (lease_id);
create index inspection_lease_idx on inspection (lease_id, kind);
create index inspection_photo_finding_idx on inspection_photo (finding_id) where uploaded;

-- The statement and settlement paths filter invoices by status before summing them.
create index invoice_open_idx on invoice (lease_id) where status in ('issued', 'part_paid');
