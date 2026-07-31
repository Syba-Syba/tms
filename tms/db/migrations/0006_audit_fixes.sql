-- Audit fixes.

-- 1. Leases and invoices need human references. lpad() on a uuid does nothing, so the payment
--    reference printed on invoices was the raw uuid. A bank reference field is ~20 characters
--    and a tenant types it by hand, so it has to be short.
create sequence lease_ref_seq start 101;
alter table lease add column ref_no bigint not null default nextval('lease_ref_seq');
alter table lease add constraint lease_ref_no_key unique (ref_no);

create sequence invoice_ref_seq start 1001;
alter table invoice add column ref_no bigint not null default nextval('invoice_ref_seq');
alter table invoice add constraint invoice_ref_no_key unique (ref_no);

-- 2. The landlord was never tied to a Cognito identity, so authorization could only ask
--    "is this person in the landlord group", never "is this person THIS unit's landlord".
alter table landlord add column cognito_sub text unique;

-- 3. Photo rows were written when the presigned URL was issued, before the browser had
--    uploaded anything. A failed upload left a row pointing at a key that does not exist,
--    and sealing an inspection then died fetching it.
alter table inspection_photo add column uploaded boolean not null default false;
alter table ticket_photo add column uploaded boolean not null default false;

-- Existing rows predate the flag and their objects are already in S3.
update inspection_photo set uploaded = true;
update ticket_photo set uploaded = true;
