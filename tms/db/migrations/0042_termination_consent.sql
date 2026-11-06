-- A notice the landlord records for the tenant (a "mutual" one, or the tenant's notice dated
-- before the day it was entered) is only the landlord's word. It used to end a fixed term the
-- same day with nothing from the tenant. Such a notice now waits for the tenant to confirm it:
-- until then the deposit cannot be settled and the tenant can withdraw it.
alter table termination
  add column needs_tenant_confirmation boolean not null default false,
  add column tenant_confirmed_at timestamptz,
  -- The refund the statement promised, deposit and rent credit together. The refund reminder
  -- read only the deposit ledger, so a refund paid from rent credit was never reminded.
  add column refund_cents bigint check (refund_cents >= 0);
