/**
 * What each database role may do, as plain SQL. db-roles.mjs runs these as the owner on every
 * start; a test runs the same list against PGlite and then runs an erasure as tms_server, so a
 * grant the app needs cannot go missing unnoticed.
 *
 * Role names are fixed identifiers chosen by db-roles.mjs, never user input.
 */
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

export function grantStatements({ server, backup, owner, database }) {
  const S = ident(server);
  return [
    // Only the owner creates anything. PUBLIC may connect to this database and no other.
    `revoke create on schema public from public`,
    `revoke all on database ${ident(database)} from public`,
    `grant connect on database ${ident(database)} to ${S}`,
    `grant connect on database ${ident(database)} to ${ident(backup)}`,
    `grant usage on schema public to ${S}, ${ident(backup)}`,

    // What exists now, and what later migrations create.
    `grant select, insert, update, delete on all tables in schema public to ${S}`,
    `grant usage, select on all sequences in schema public to ${S}`,
    `alter default privileges for role ${ident(owner)} in schema public
       grant select, insert, update, delete on tables to ${S}`,
    `alter default privileges for role ${ident(owner)} in schema public grant usage, select on sequences to ${S}`,
    // Which migrations ran is the owner's business; the app only reads it for the health check.
    `revoke insert, update, delete on schema_migrations from ${S}`,
    // Records of money and history are never deleted by the app (checked against every
    // `delete from` in tms/api/src), so a bug that runs SQL as the app cannot erase them either.
    // Cascades from a deleted parent still work: Postgres runs those as the table owner.
    // A new table still gets the default grants above; add it here if the app never deletes from it.
    `revoke delete on payment, deposit_ledger, billing_event, billing_invoice, consent from ${S}`,
    // The audit trail is written once. Only a privacy erasure rewrites it: the detail column, and
    // for a landlord's erasure the actor, which moves to the 'erased:<stand-in>' record
    // (lib/privacy.ts). The privacy sweep deletes failed sign-ins older than 90 days
    // (handlers/privacy-sweep.ts). The triggers let the app do those and nothing else. Other
    // roles (the owner, restores, the tests) are not limited by them.
    `revoke update on audit_log from ${S}`,
    `grant update (detail, actor_sub) on audit_log to ${S}`,
    `revoke truncate on audit_log from ${S}`,
    `create or replace function tms_audit_log_keep() returns trigger language plpgsql as $$
     begin
       if current_user = ${literal(server)}
          and not (old.action = 'auth.login_failed' and old.at < now() - interval '90 days') then
         raise exception 'audit_log rows are kept; only failed sign-ins older than 90 days expire'
           using errcode = 'insufficient_privilege';
       end if;
       return old;
     end $$`,
    `drop trigger if exists tms_audit_log_keep on audit_log`,
    `create trigger tms_audit_log_keep before delete on audit_log for each row execute function tms_audit_log_keep()`,
    // An actor may only be replaced by an erased stand-in, so the app cannot pin an action on
    // someone else.
    `create or replace function tms_audit_log_actor() returns trigger language plpgsql as $$
     begin
       if current_user = ${literal(server)}
          and new.actor_sub is distinct from old.actor_sub
          and coalesce(new.actor_sub, '') not like 'erased:%' then
         raise exception 'audit_log actors are kept; only an erasure replaces one, with an erased stand-in'
           using errcode = 'insufficient_privilege';
       end if;
       return new;
     end $$`,
    `drop trigger if exists tms_audit_log_actor on audit_log`,
    `create trigger tms_audit_log_actor before update of actor_sub on audit_log for each row execute function tms_audit_log_actor()`,
  ];
}
