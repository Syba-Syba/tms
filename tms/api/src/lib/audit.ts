import { query } from './db';

type Run = typeof query;

/**
 * Every state change is written here. Rental disputes are won on records, not memory.
 *
 * Pass the transaction's `run` when calling from inside withTransaction. Without it the row
 * goes through the pool on a second connection: on a pool of two, two concurrent callers each
 * holding one connection and waiting for another never finish, and on a rollback the audit
 * row survives the change it describes.
 */
export async function audit(
  entry: {
    actorSub: string;
    actorRole: string;
    action: string;
    entity: string;
    entityId: string | null;
    detail?: unknown;
  },
  run: Run = query,
) {
  await run(
    `insert into audit_log (actor_sub, actor_role, action, entity, entity_id, detail)
     values ($1, $2, $3, $4, $5, $6)`,
    [entry.actorSub, entry.actorRole, entry.action, entry.entity, entry.entityId, entry.detail ?? null],
  );
}
