-- Public listings: what an applicant sees before they have an account. A vacant unit shows on
-- its landlord's listings page unless it is hidden, with its photos and a short description.

alter table unit
  add column description    text     check (description is null or length(description) <= 2000),
  add column available_from date,
  add column furnished      boolean  not null default false,
  add column pets_allowed   boolean  not null default false,
  add column parking_bays   smallint not null default 0 check (parking_bays between 0 and 10),
  add column listed         boolean  not null default true;

-- Photos go up through a presigned link and count only once confirmed: the server has read
-- the bytes, checked they are a JPEG or PNG and kept its own copy.
create table unit_photo (
  id           uuid primary key default gen_random_uuid(),
  unit_id      uuid        not null references unit (id) on delete cascade,
  s3_key       text        not null,
  content_type text        not null check (content_type in ('image/jpeg', 'image/png')),
  size_bytes   integer     not null check (size_bytes > 0),
  uploaded     boolean     not null default false,
  position     smallint    not null default 0,
  created_at   timestamptz not null default now()
);

create index unit_photo_unit_idx on unit_photo (unit_id, position);
