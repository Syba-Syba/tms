-- A trial runs 30 days from the landlord's own day in Johannesburg. current_date is the
-- server's UTC day, so a landlord who signed up between 00:00 and 02:00 SAST got a trial one
-- day short of what the app showed them.
create or replace function landlord_subscription() returns trigger language plpgsql as $$
begin
  insert into subscription (landlord_id, trial_ends_on)
  values (new.id, (now() at time zone 'UTC' + interval '2 hours')::date + 30)
  on conflict (landlord_id) do nothing;
  return new;
end
$$;
