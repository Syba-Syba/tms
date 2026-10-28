import { withTransaction, query } from '../lib/db';
import { ensureCase, owingLeases, stepsOf } from '../lib/arrears';
import { leaseParties } from '../lib/lease-parties';
import { jobLogger } from '../lib/logger';
import { notify } from '../lib/notify';
import { daysBetween, letterAllowed, reminderDue, type Step } from '../domain/arrears';
import { sastToday } from '../domain/dates';
import { zar } from '../domain/money';

const log = jobLogger('arrears-run');

/**
 * Runs every morning, after the notification sweep. Opens a case for each lease that has fallen
 * behind, sends the reminder due today, tells the landlord once the letter of demand is ready,
 * and closes the case of anyone now paid up. Every step is a unique row, so a second run on the
 * same day sends nothing.
 *
 * Reminders hold while a slip is waiting to be checked (the tenant says they have paid) and
 * while the landlord has paused them (a payment plan, a dispute).
 */
export const handler = async (now: Date = new Date()) => {
  const today = sastToday(now);
  const counts = { owing: 0, reminders: 0, letterReady: 0, held: 0, closed: 0 };
  const owing = await owingLeases(today);
  counts.owing = owing.length;

  for (const lease of owing) {
    const daysLate = daysBetween(lease.oldestDueOn, today);
    if (daysLate < 1) continue;
    const parties = await leaseParties(lease.leaseId);
    if (!parties) continue;

    const result = await withTransaction(async (run) => {
      const arrearsCase = await ensureCase(run, lease.leaseId, today);
      if ((arrearsCase.paused_until && arrearsCase.paused_until >= today) || lease.slipPending) return 'held' as const;
      const taken = new Set<Step>(
        (await run<{ step: Step }>('select step from arrears_step where case_id = $1', [arrearsCase.id])).map((row) => row.step),
      );
      const reminder = reminderDue(daysLate, taken);
      let sent = false;
      if (reminder) {
        const inserted = await run(
          `insert into arrears_step (case_id, step, taken_on, days_late, outstanding_cents, taken_by)
           values ($1, $2, $3, $4, $5, 'job') on conflict (case_id, step) do nothing returning id`,
          [arrearsCase.id, reminder, today, daysLate, lease.outstandingCents],
        );
        if (inserted.length > 0) {
          await notify(
            {
              leaseId: lease.leaseId,
              to: { sub: parties.tenantSub, email: parties.tenantEmail, phone: parties.tenantPhone },
              kind: `arrears_${reminder}`,
              dedupeKey: `arrears:${arrearsCase.id}:${reminder}`,
              data: {
                amount: zar(lease.outstandingCents), dueOn: lease.oldestDueOn, daysLate: String(daysLate),
                reference: parties.ref, unit: parties.unit,
              },
            },
            run,
          );
          taken.add(reminder);
          sent = true;
        }
      }
      let ready = false;
      if (taken.has('reminder_7') && letterAllowed(daysLate, taken) && parties.landlordSub) {
        // Once per case, deduplicated by key: the landlord decides, the system only says it is time.
        await notify(
          {
            leaseId: lease.leaseId,
            to: { sub: parties.landlordSub, email: parties.landlordEmail, phone: parties.landlordPhone },
            kind: 'arrears_letter_ready',
            dedupeKey: `arrears_letter_ready:${arrearsCase.id}`,
            data: {
              tenant: parties.tenantName, unit: parties.unit, amount: zar(lease.outstandingCents),
              daysLate: String(daysLate),
            },
          },
          run,
        );
        ready = true;
      }
      return { sent, ready };
    });
    if (result === 'held') counts.held += 1;
    else {
      if (result.sent) counts.reminders += 1;
      if (result.ready) counts.letterReady += 1;
    }
  }

  // Anyone no longer owing: their case closes. History stays on the lease.
  const owingIds = owing.map((lease) => lease.leaseId);
  const closed = await query(
    `update arrears_case set closed_on = $1, paused_until = null
      where closed_on is null and not (lease_id = any($2::uuid[]))
      returning id`,
    [today, owingIds],
  );
  counts.closed = closed.length;

  log.info('Arrears run complete.', counts);
  return counts;
};

/** For a test or a manual run: the steps on a lease's open case. */
export const openSteps = async (leaseId: string) => {
  const [row] = await query<{ id: string }>('select id from arrears_case where lease_id = $1 and closed_on is null', [leaseId]);
  return row ? stepsOf(row.id) : [];
};
