import { query } from './db';

/** Every state change is written here. Rental disputes are won on records, not memory. */
export async function audit(entry: {
  actorSub: string;
  actorRole: string;
  action: string;
  entity: string;
  entityId: string | null;
  detail?: unknown;
}) {
  await query(
    `insert into audit_log (actor_sub, actor_role, action, entity, entity_id, detail)
     values ($1, $2, $3, $4, $5, $6)`,
    [entry.actorSub, entry.actorRole, entry.action, entry.entity, entry.entityId, entry.detail ?? null],
  );
}
