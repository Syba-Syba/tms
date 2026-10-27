import { query, withTransaction } from '../lib/db';
import { jobLogger } from '../lib/logger';
import { sastToday } from '../domain/dates';
import { activateScheduledLease, FULLY_SIGNED_SQL } from '../lib/activation';
import { notify } from '../lib/notify';
import { leaseParties } from '../lib/recipients';

const log = jobLogger('leases-activate');

/**
 * Runs each morning. A scheduled lease becomes the live one on its start date, and the lease it
 * replaced retires the same second.
 *
 * Only once both parties have signed it. A renewal accepted but never signed used to go live
 * regardless, a tenancy on a document nobody had put their name to. Unsigned, it waits, and the
 * current lease carries on month to month (RHA s5(5)) until it is signed.
 */
export const handler = async () => {
  const today = sastToday();
  const due = await query<{ id: string }>(
    `select l.id from lease l
      where l.status = 'scheduled' and l.start_date <= $1::date and ${FULLY_SIGNED_SQL('l')}
      order by l.start_date`,
    [today],
  );

  // Each lease in its own transaction. One that cannot activate used to roll back the whole
  // run, so every other lease due that morning stayed scheduled with it, day after day.
  const activated: string[] = [];
  for (const { id } of due) {
    try {
      const done = await withTransaction(async (run) => {
        // Checked again under the lock: signing may have activated it in the meantime.
        const [lease] = await run<{ id: string; previous_lease_id: string | null; unit_id: string }>(
          `select l.id, l.previous_lease_id, l.unit_id
             from lease l
            where l.id = $1 and l.status = 'scheduled' and l.start_date <= $2::date and ${FULLY_SIGNED_SQL('l')}
            for update of l`,
          [id, today],
        );
        if (!lease) return false;
        await activateScheduledLease(run, lease);
        return true;
      });
      if (done) activated.push(id);
    } catch (error) {
      log.error('Lease activation failed.', { leaseId: id, error });
    }
  }

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
