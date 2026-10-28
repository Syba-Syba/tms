-- More than one landlord on one installation, and more than one person per landlord.
--
-- Until now a landlord was one sign-in: landlord.cognito_sub. Access checks compared it with
-- the caller. A landlord account now has members: one owner and any number of agents. The
-- owner column stays, kept in step with the owner's membership by a trigger, so notifications
-- addressed to the landlord and every seed that inserts a landlord keep working unchanged.

create table landlord_member (
  landlord_id uuid        not null references landlord (id) on delete cascade,
  -- One landlord per sign-in. An agent working for two landlords uses two emails, so no
  -- screen ever has to ask which landlord a request is for.
  sub         text        not null unique,
  role        text        not null check (role in ('owner', 'agent')),
  added_by    text,
  created_at  timestamptz not null default now(),
  primary key (landlord_id, sub)
);

create unique index landlord_member_one_owner on landlord_member (landlord_id) where role = 'owner';

insert into landlord_member (landlord_id, sub, role)
select id, cognito_sub, 'owner' from landlord where cognito_sub is not null
on conflict do nothing;

create function landlord_owner_member() returns trigger language plpgsql as $$
begin
  if new.cognito_sub is not null
     and (tg_op = 'INSERT' or new.cognito_sub is distinct from old.cognito_sub) then
    delete from landlord_member where landlord_id = new.id and role = 'owner';
    insert into landlord_member (landlord_id, sub, role) values (new.id, new.cognito_sub, 'owner')
    on conflict (sub) do nothing;
  end if;
  return new;
end
$$;

create trigger landlord_owner_member
  after insert or update of cognito_sub on landlord
  for each row execute function landlord_owner_member();

-- What a tenant needs to pay and an applicant needs to find the landlord. Bank details print
-- on invoices and the letter of demand, which said "the account on your lease" with no account.
alter table landlord
  add column slug                text unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  add column registration_no     text,
  add column bank_name           text,
  add column bank_account_holder text,
  add column bank_account_number text check (bank_account_number ~ '^[0-9]{6,16}$'),
  add column bank_branch_code    text check (bank_branch_code ~ '^[0-9]{6}$');

-- Agents join by invitation from the owner. Only a hash of the token is kept, as for password
-- resets: the token travels once, in the email.
create table landlord_invite (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid        not null references landlord (id) on delete cascade,
  email       text        not null,
  name        text        not null,
  token_hash  text        not null unique,
  invited_by  text        not null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_sub text,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create unique index landlord_invite_open on landlord_invite (landlord_id, email)
  where accepted_at is null and revoked_at is null;
