-- An erasure request is answered by each landlord the person dealt with, for that landlord's
-- records only. One request used to be visible to all of them, and whichever answered first
-- erased (or refused) for everyone, reaching records another landlord is responsible for.
alter table privacy_request add column landlord_id uuid references landlord (id) on delete cascade;

drop index privacy_request_one_open;
-- One open request per person per landlord. Requests from before this change have no landlord.
create unique index privacy_request_one_open
  on privacy_request (person_sub, coalesce(landlord_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'pending';

create index privacy_request_landlord_idx on privacy_request (landlord_id, status);
