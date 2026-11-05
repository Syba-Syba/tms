-- Serving notice lapses an open renewal offer and cancels an accepted, unsigned renewal along
-- with its scheduled lease. Withdrawing the notice used to leave them that way, so a tenant who
-- changed their mind lost the renewal they had been offered. The notice now records what it
-- undid, and withdrawing it restores whatever is still valid.
alter table termination
  add column lapsed_renewal_ids uuid[] not null default '{}',
  add column cancelled_lease_id uuid references lease (id);
