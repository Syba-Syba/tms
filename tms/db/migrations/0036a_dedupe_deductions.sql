-- Before 0037 nothing stopped the same outgoing finding being deducted twice (a double tap on
-- Deduct, or the card offering it again), so a database deployed earlier can hold duplicates.
-- 0037 then fails to create its unique index, the migration stops, and the app never starts.
-- This file sorts before 0037, so it runs first wherever 0037 has not yet run. Where 0037 has
-- run there are no duplicates and nothing here changes anything.
--
-- The first deduction per (termination, finding) is kept. On a settled termination the later
-- ones stay, since the sealed statement and the deposit ledger count them, but no longer point
-- at the finding. On any other termination they are deleted, as the landlord never meant them.

with ranked as (
  select d.id, t.status,
         row_number() over (partition by d.termination_id, d.finding_id order by d.created_at, d.id) as n
    from deposit_deduction d
    join termination t on t.id = d.termination_id
   where d.finding_id is not null
)
update deposit_deduction d set finding_id = null
  from ranked r
 where r.id = d.id and r.n > 1 and r.status = 'settled';

with ranked as (
  select d.id,
         row_number() over (partition by d.termination_id, d.finding_id order by d.created_at, d.id) as n
    from deposit_deduction d
   where d.finding_id is not null
)
delete from deposit_deduction d
 using ranked r
 where r.id = d.id and r.n > 1;
