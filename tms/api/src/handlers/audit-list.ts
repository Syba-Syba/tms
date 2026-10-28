import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, forbidden, json, route } from '../lib/http';

/** Entities the log can be filtered to. Anything else is refused, never put into SQL. */
const ENTITIES = [
  'property', 'unit', 'application', 'lease', 'inspection', 'renewal', 'termination', 'ticket', 'credential',
  'bank_import', 'expense', 'privacy_request', 'person', 'landlord',
] as const;

/**
 * The audit log, read back. A landlord sees what happened on their own properties, and
 * everything done by or against their own account, such as sign-ins and failed attempts.
 * Rows about another landlord's units, or another person's account, stay hidden. Newest
 * first, a page at a time, with the last id as the cursor.
 */
export const handler = route(async (event) => {
  const person = caller(event);
  if (!person.groups.includes('landlord')) throw forbidden('Only a landlord reads the audit log.');

  const params = event.queryStringParameters ?? {};
  const limit = params.limit ? Number(params.limit) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('limit must be 1 to 100.');
  const before = params.before ? Number(params.before) : null;
  if (before !== null && (!Number.isInteger(before) || before < 1)) throw badRequest('before must be a row id.');
  const entity = params.entity ?? null;
  if (entity !== null && !(ENTITIES as readonly string[]).includes(entity)) throw badRequest('Unknown entity.');
  const entityId = params.entityId ?? null;
  if (entityId !== null && !/^[0-9a-f-]{36}$/i.test(entityId)) throw badRequest('entityId must be a uuid.');

  const rows = await query<{
    id: string; at: string; action: string; entity: string; entity_id: string | null;
    actor_sub: string | null; actor_role: string | null; detail: unknown;
    actor_name: string | null; lease_id: string | null;
  }>(
    `with me as (select landlord_id from landlord_member where sub = $1),
     -- The owner and every agent: what any of them did shows to all of them.
     team as (select sub from landlord_member where landlord_id = (select landlord_id from me)),
     mine as (
       select p.id from property p where p.landlord_id = (select landlord_id from me)
     ),
     my_units as (select u.id from unit u where u.property_id in (select id from mine)),
     my_leases as (select l.id from lease l where l.unit_id in (select id from my_units)),
     scoped as (
       select a.*,
              case a.entity
                when 'lease' then a.entity_id
                when 'inspection' then (select lease_id from inspection where id = a.entity_id)
                when 'renewal' then (select lease_id from renewal where id = a.entity_id)
                when 'termination' then (select lease_id from termination where id = a.entity_id)
                when 'ticket' then (select lease_id from ticket where id = a.entity_id)
              end as lease_id
         from audit_log a
        where ($2::bigint is null or a.id < $2)
          and ($3::text is null or a.entity = $3)
          and ($4::uuid is null or a.entity_id = $4)
     )
     select s.id::text, s.at::text, s.action, s.entity, s.entity_id, s.actor_sub, s.actor_role, s.detail,
            s.lease_id,
            coalesce(case when lm.role = 'agent' then lc.name end, ll.trading_name,
                     ap.first_name || ' ' || ap.last_name) as actor_name
       from scoped s
       left join landlord_member lm on lm.sub = s.actor_sub
       left join landlord ll on ll.id = lm.landlord_id
       left join local_credential lc on lc.sub = s.actor_sub
       left join applicant ap on ap.cognito_sub = s.actor_sub
      where case s.entity
              -- Account rows belong to the account, whoever's units they touch.
              when 'credential' then s.actor_sub = $1
              when 'landlord' then s.entity_id = (select landlord_id from me)
              when 'property' then s.entity_id in (select id from mine)
              when 'unit' then s.entity_id in (select id from my_units)
              when 'application' then s.entity_id in (select id from application where unit_id in (select id from my_units))
              when 'lease' then s.entity_id in (select id from my_leases)
              when 'inspection' then s.lease_id in (select id from my_leases)
              when 'renewal' then s.lease_id in (select id from my_leases)
              when 'termination' then s.lease_id in (select id from my_leases)
              when 'ticket' then s.lease_id in (select id from my_leases)
              -- Money and privacy records this landlord owns. Expenses can be deleted, so the
              -- landlord's own actions on them show by actor as well, below.
              when 'bank_import' then s.entity_id in (
                select b.id from bank_import b where b.landlord_id = (select landlord_id from me))
              when 'expense' then s.entity_id in (
                select e.id from expense e where e.landlord_id = (select landlord_id from me))
              when 'privacy_request' then s.actor_sub in (select sub from team)
              -- A deleted property or unit leaves no row to join to; what the landlord did
              -- themselves still shows. Jobs span every landlord, so they stay out.
              else false
            end
         or (s.entity in ('property', 'unit', 'expense', 'person') and s.actor_sub in (select sub from team))
      order by s.id desc
      limit $5`,
    [person.sub, before, entity, entityId, limit + 1],
  );

  const page = rows.slice(0, limit);
  return json(200, {
    items: page.map((row) => ({
      id: Number(row.id),
      at: row.at,
      action: row.action,
      entity: row.entity,
      entityId: row.entity_id,
      leaseId: row.lease_id,
      actor: {
        role: row.actor_role,
        name: row.actor_sub === person.sub ? 'You' : (row.actor_name ?? (row.actor_role === 'job' ? 'Scheduled job' : 'Unknown')),
      },
      detail: row.detail,
    })),
    nextBefore: rows.length > limit ? Number(page[page.length - 1]!.id) : null,
  });
});
