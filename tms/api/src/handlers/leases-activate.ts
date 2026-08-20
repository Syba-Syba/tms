import { withTransaction } from '../lib/db';
import { jobLogger } from '../lib/logger';

const log = jobLogger('leases-activate');

/**
 * Runs each morning. A scheduled lease becomes the live one on its start date, and the lease it
 * replaced retires the same second. Doing both in one transaction is what keeps
 * lease_one_live_per_unit satisfied at every instant.
 */
export const handler = async () => {
  const activated = await withTransaction(async (run) => {
    const due = await run<{ id: string; previous_lease_id: string | null; unit_id: string }>(
      `select id, previous_lease_id, unit_id
         from lease
        where status = 'scheduled' and start_date <= current_date
        for update`,
    );

    for (const lease of due) {
      if (lease.previous_lease_id) {
        await run(
          `update lease set status = 'terminated' where id = $1 and status = 'active'`,
          [lease.previous_lease_id],
        );
      }
      await run(`update lease set status = 'active', activated_at = now() where id = $1`, [lease.id]);
      await run(`update unit set status = 'occupied' where id = $1`, [lease.unit_id]);
      // The deposit ledger follows the tenant, not the lease, so the interest history moves
      // across with them rather than being refunded and recollected.
      await run(
        `update deposit_ledger set lease_id = $1 where lease_id = $2`,
        [lease.id, lease.previous_lease_id],
      );
    }
    return due.length;
  });

  log.info('Lease activation complete.', { activated });
  return { activated };
};
