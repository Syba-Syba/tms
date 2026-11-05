import { requireLeaseAccessVia } from '../lib/access';
import { badRequest, forbidden, json, route } from '../lib/http';
import { isoDate, sastToday } from '../domain/dates';
import { settlementFigures } from './terminations-settle';

/**
 * The settlement before it happens: what is held, what comes off it, and the exact refund or
 * debt the statement will carry. The settle dialog shows this so the landlord confirms a figure,
 * not a list. `restoredOn` moves the 14 day refund clock the same way settling does.
 */
export const handler = route(async (event) => {
  const terminationId = event.pathParameters?.id;
  if (!terminationId) throw badRequest('A termination id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from termination where id = $1',
    [terminationId],
    'Termination',
  );
  if (!access.isLandlord) throw forbidden('Only the landlord settles the deposit.');
  const raw = event.queryStringParameters?.restoredOn;
  const restoredOn = raw ? new Date(raw) : undefined;
  if (restoredOn && Number.isNaN(restoredOn.getTime())) throw badRequest('restoredOn must be a date.');

  const today = sastToday();
  const figures = await settlementFigures(terminationId, today, restoredOn);
  const { context, deductions, rule, summary, dueBy } = figures;
  // The same refusals settling makes, said before the landlord confirms rather than after.
  const blocker =
    today < context.effective_on
      ? `The lease runs until ${context.effective_on}. The deposit is settled after the tenant has moved out.`
      : figures.blocker;
  return json(200, {
    effectiveOn: context.effective_on,
    depositCents: summary.depositCents,
    interestCents: summary.interestCents,
    heldCents: summary.heldCents,
    deductionsCents: deductions.reduce((sum, row) => sum + Number(row.amount_cents), 0),
    arrearsCents: summary.arrearsCents,
    penaltyCents: summary.penaltyCents,
    rentCreditCents: summary.rentCreditCents,
    refundCents: summary.refundCents,
    tenantOwesCents: summary.tenantOwesCents,
    refundRule: rule,
    refundDueBy: isoDate(dueBy),
    blocker,
  });
});
