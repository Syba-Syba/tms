-- Upload links for application documents create no row until /documents/confirm, so an upload
-- that was never confirmed was invisible: nothing counted it and nothing ever deleted it, and a
-- loop of presign calls could fill the disk 15 MB at a time. Each link is now recorded here.
-- The uploads sweep deletes the object for any entry older than an hour that no
-- application_document row took up, then the entry itself.
--
-- No foreign key: an entry must outlive its application long enough for the sweep to remove
-- the object it points at.
create table pending_upload (
  s3_key         text        primary key,
  application_id uuid        not null,
  created_by     text,
  created_at     timestamptz not null default now()
);

create index pending_upload_application_idx on pending_upload (application_id, created_at);
create index pending_upload_created_idx on pending_upload (created_at);

-- The sweep and the per-record caps look for unconfirmed uploads by age.
create index ticket_photo_pending_idx on ticket_photo (uploaded_at) where not uploaded;
create index inspection_photo_pending_idx on inspection_photo (uploaded_at) where not uploaded;
create index unit_photo_pending_idx on unit_photo (created_at) where not uploaded;
create index payment_proof_uploading_idx on payment_proof (created_at) where status = 'uploading';
