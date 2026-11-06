-- Every name a person's record has carried, so an erasure can find them all.
--
-- The applicant row is shared by every landlord the person applies to, and applying again
-- rewrites its name. Messages and activity copy the name in at the time ("Proof of payment from
-- Naledi Phiri"), so an erasure that only knew today's name ("Naledi Mokoena") left the old one
-- in the first landlord's records. Claiming an imported tenancy deletes the row the landlord
-- typed in, and its name with it. Erasure (tms/api/src/lib/privacy.ts) scrubs each name here.
create table applicant_name (
  applicant_id uuid        not null references applicant (id) on delete cascade,
  first_name   text        not null,
  last_name    text        not null,
  first_seen   timestamptz not null default now(),
  primary key (applicant_id, first_name, last_name)
);

-- An erased record's 'Erased person' is not a name anyone used.
create or replace function tms_applicant_name_keep() returns trigger language plpgsql as $$
begin
  if new.erased_at is null then
    insert into applicant_name (applicant_id, first_name, last_name)
    values (new.id, new.first_name, new.last_name)
    on conflict do nothing;
  end if;
  return new;
end $$;

create trigger tms_applicant_name_keep
  after insert or update of first_name, last_name on applicant
  for each row execute function tms_applicant_name_keep();

-- A lease that moves to another record (an imported tenancy claimed by an account that already
-- had one) takes the names it was let under with it. Not onto an erased stand-in.
create or replace function tms_lease_names_follow() returns trigger language plpgsql as $$
begin
  if new.applicant_id is distinct from old.applicant_id
     and exists (select 1 from applicant where id = new.applicant_id and erased_at is null) then
    insert into applicant_name (applicant_id, first_name, last_name)
    select new.applicant_id, n.first_name, n.last_name from applicant_name n where n.applicant_id = old.applicant_id
    on conflict do nothing;
  end if;
  return new;
end $$;

create trigger tms_lease_names_follow
  after update of applicant_id on lease
  for each row execute function tms_lease_names_follow();

insert into applicant_name (applicant_id, first_name, last_name)
select id, first_name, last_name from applicant where erased_at is null
on conflict do nothing;
