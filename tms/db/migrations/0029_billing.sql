-- What each landlord pays for the service. One row per landlord account.
create table subscription (
  landlord_id        uuid primary key references landlord (id) on delete cascade,
  plan               text check (plan in ('starter', 'standard', 'pro')),
  status             text        not null default 'trialing'
                     check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_on      date        not null,
  -- The last day paid for. Payments extend it a month at a time.
  current_period_end date,
  provider           text,
  -- The payment provider's handle on the recurring payment, for changing or cancelling it.
  provider_token     text unique,
  updated_at         timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

-- Every landlord starts on a trial: those already here today, and every one created after.
insert into subscription (landlord_id, trial_ends_on) select id, current_date + 30 from landlord;

create function landlord_subscription() returns trigger language plpgsql as $$
begin
  insert into subscription (landlord_id, trial_ends_on) values (new.id, current_date + 30)
  on conflict (landlord_id) do nothing;
  return new;
end
$$;

create trigger landlord_subscription after insert on landlord
  for each row execute function landlord_subscription();

-- A checkout the owner started: the reference the payment comes back with, and what it was for.
create table billing_checkout (
  id           uuid primary key default gen_random_uuid(),
  landlord_id  uuid        not null references landlord (id) on delete cascade,
  plan         text        not null,
  amount_cents bigint      not null check (amount_cents > 0),
  created_by   text        not null,
  completed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- Every notification the payment provider sent, kept as received, with whether it checked out.
create table billing_event (
  id          uuid primary key default gen_random_uuid(),
  landlord_id uuid references landlord (id) on delete set null,
  provider    text        not null,
  kind        text        not null,
  -- The provider's own id for the payment. PayFast can send the same notification twice.
  external_id text,
  verified    boolean     not null,
  problem     text,
  payload     jsonb       not null,
  created_at  timestamptz not null default now()
);

create unique index billing_event_once on billing_event (provider, external_id)
  where external_id is not null and verified;
