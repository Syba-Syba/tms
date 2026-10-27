import { withTransaction } from '../lib/db';
import { jobLogger } from '../lib/logger';
import { sastToday } from '../domain/dates';
import { audit } from '../lib/audit';
import { notify } from '../lib/notify';
import { leaseParties } from '../lib/recipients';

const log = jobLogger('leases-activate');

/**
 * Runs each morning. A scheduled lease becomes the live one on its start date, and the lease it
 * replaced retires the same second. Doing both in one transaction is what keeps
 * lease_one_live_per_unit satisfied at every instant.
 */
export const handler = async () => {
  const today = sastToday();
  const activated = await withTransaction(async (run) => {
    const due = await run<{ id: string; previous_lease_id: string | null; unit_id: string }>(
      `select id, previous_lease_id, unit_id
         from lease
        where status = 'scheduled' and start_date <= $1::date
        for update`,
      [today],
    );

    for (const lease of due) {
      if (lease.previous_lease_id) {
        await run(
          `update lease set status = 'terminated' where id = $1 and status = 'active'`,
          [lease.previous_lease_id],
        );
        // Whatever the tenant still owed on the old lease is still owed. Left behind on a
        // terminated lease it dropped off every screen and out of the eventual exit
        // settlement, which only looks at the live lease. The invoices and the payments
        // against them move across with the tenant, as the deposit does below.
        await run(
          `update payment set lease_id = $1
            where invoice_id in (select id from invoice where lease_id = $2 and status in ('issued', 'part_paid'))`,
          [lease.id, lease.previous_lease_id],
        );
        await run(
          `update invoice set lease_id = $1 where lease_id = $2 and status in ('issued', 'part_paid')`,
          [lease.id, lease.previous_lease_id],
        );
      }
      await run(`update lease set status = 'active', activated_at = now() where id = $1`, [lease.id]);
      await run(`update unit set status = 'occupied' where id = $1`, [lease.unit_id]);
      await audit(
        {
          actorSub: 'system',
          actorRole: 'job',
          action: 'lease.activated',
          entity: 'lease',
          entityId: lease.id,
          detail: { previousLeaseId: lease.previous_lease_id },
        },
        run,
      );
      // The deposit ledger follows the tenant, not the lease, so the interest history moves
      // across with them rather than being refunded and recollected.
      if (lease.previous_lease_id) {
        await run(`update deposit_ledger set lease_id = $1 where lease_id = $2`, [
          lease.id,
          lease.previous_lease_id,
        ]);
      }
    }
    return due.map((lease) => lease.id);
  });

  for (const leaseId of activated) {
    try {
      const parties = await leaseParties(leaseId);
      if (!parties?.tenant) continue;
      await notify({
        leaseId,
        to: parties.tenant,
        kind: 'lease_activated',
        dedupeKey: `lease_activated:${leaseId}`,
        data: { reference: parties.reference, unit: parties.unit },
      });
    } catch (error) {
      log.error('Lease activated notification failed.', { leaseId, error });
    }
  }

  log.info('Lease activation complete.', { activated: activated.length });
  return { activated: activated.length };
};
