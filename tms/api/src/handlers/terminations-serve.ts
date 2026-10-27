import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, parseBody, route } from '../lib/http';
import {
  earliestEffectiveDate,
  NOTICE_BUSINESS_DAYS,
  serveNoticeSchema,
  type TerminationReason,
} from '../domain/termination';
import { addDaysIso, dateFromIso, isoDate, sastToday } from '../domain/dates';
import { trimInvoicesAfter } from '../lib/billing';
import { notify } from '../lib/notify';
import { query } from '../lib/db';

/**
 * Which reasons each side may give. The reason sets the notice period, so letting a tenant
 * pick 'mutual' (no notice) or 'end_of_term' on a lease that had already run out ended the
 * lease the same day; backdating noticeGivenOn ended it in the past. Both sides are now held
 * to the reasons that are theirs to give, and the tenant's notice date is today, full stop.
 */
const REASONS_BY_INITIATOR: Record<'tenant' | 'landlord' | 'mutual', readonly TerminationReason[]> = {
  tenant: ['early_tenant', 'breach_by_landlord', 'end_of_term'],
  landlord: ['breach_by_tenant', 'end_of_term'],
  mutual: ['mutual'],
};

/** A landlord may record a paper notice received a little while ago, not rewrite last year. */
const LANDLORD_BACKDATE_DAYS = 30;

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  const input = parseBody(event, serveNoticeSchema);
  const penaltyCents = input.penaltyCents ?? 0;

  // You may only serve notice as yourself. Mutual needs both, so the landlord records it.
  if (input.initiatedBy === 'tenant' && !access.isTenant) {
    throw forbidden('Only the tenant serves the tenant’s notice.');
  }
  if (input.initiatedBy !== 'tenant' && !access.isLandlord) {
    throw forbidden('Only the landlord records this notice.');
  }
  if (!REASONS_BY_INITIATOR[input.initiatedBy].includes(input.reason)) {
    throw badRequest(`A notice from the ${input.initiatedBy} cannot be given as "${input.reason.replace(/_/g, ' ')}".`, {
      reason: `Choose one of: ${REASONS_BY_INITIATOR[input.initiatedBy].map((r) => r.replace(/_/g, ' ')).join(', ')}.`,
    });
  }
  // A penalty is a landlord's charge under CPA s14. A tenant cannot set one on themselves.
  if (penaltyCents > 0 && !access.isLandlord) {
    throw forbidden('Only the landlord sets a cancellation penalty.');
  }

  const today = sastToday();
  // The tenant's notice is given the moment it is served; the clock cannot be wound back.
  const noticeGivenOn =
    access.isTenant && !access.isLandlord ? today : input.noticeGivenOn ? isoDate(input.noticeGivenOn) : today;
  if (noticeGivenOn > today) throw badRequest('The notice date cannot be in the future.');
  if (noticeGivenOn < addDaysIso(today, -LANDLORD_BACKDATE_DAYS)) {
    throw badRequest(`A notice can be recorded up to ${LANDLORD_BACKDATE_DAYS} days after it was given, not earlier.`);
  }

  const result = await withTransaction(async (run) => {
    const [lease] = await run<{ status: string; end_date: string }>(
      'select status, end_date::text from lease where id = $1 for update',
      [leaseId],
    );
    if (!lease) throw badRequest('That lease no longer exists.');
    if (lease.status !== 'active') throw conflict(`This lease is ${lease.status}.`);

    const leaseEnd = dateFromIso(lease.end_date);
    const earliest = earliestEffectiveDate(input.reason, dateFromIso(noticeGivenOn), leaseEnd);
    const effective = input.effectiveOn ? dateFromIso(isoDate(input.effectiveOn)) : earliest;
    // The parties may agree a later date than the minimum, never an earlier one.
    if (effective < earliest) {
      throw badRequest(
        `The earliest lawful end date is ${isoDate(earliest)}. ` +
          `${NOTICE_BUSINESS_DAYS[input.reason]} business days’ notice applies.`,
      );
    }
    // Nor can a lease end before today: the tenancy that ran until now happened.
    if (isoDate(effective) < today) {
      throw badRequest(`The end date cannot be before today (${today}).`);
    }

    const [termination] = await run<{ id: string }>(
      `insert into termination
         (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days, penalty_cents)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (lease_id) do nothing
       returning id`,
      [
        leaseId,
        input.initiatedBy,
        input.reason,
        noticeGivenOn,
        isoDate(effective),
        NOTICE_BUSINESS_DAYS[input.reason],
        penaltyCents,
      ],
    );
    if (!termination) throw conflict('Notice has already been served on this lease.');

    // Next month's rent may already have been invoiced in full on the 25th.
    const trimmed = await trimInvoicesAfter(run, leaseId, isoDate(effective));

    return {
      id: termination.id,
      effectiveOn: isoDate(effective),
      earliestLawful: isoDate(earliest),
      noticeGivenOn,
      invoicesAdjusted: trimmed,
    };
  });

  const [parties] = await query<{
    unit: string; tenant_sub: string | null; tenant_email: string; tenant_phone: string;
    landlord_sub: string | null; landlord_email: string;
  }>(
    `select p.name || ' ' || u.code as unit,
            a.cognito_sub as tenant_sub, a.email as tenant_email, a.phone as tenant_phone,
            ll.cognito_sub as landlord_sub, ll.email as landlord_email
       from lease l
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
       join applicant a on a.id = l.applicant_id
      where l.id = $1`,
    [leaseId],
  );
  const noticeData = {
    unit: parties?.unit ?? '',
    noticeGivenOn,
    effectiveOn: result.effectiveOn,
  };
  // Both parties, because the exit inspection deadline binds both of them.
  if (parties?.tenant_sub) {
    await notify({
      leaseId,
      to: { sub: parties.tenant_sub, email: parties.tenant_email, phone: parties.tenant_phone },
      kind: 'notice_served',
      dedupeKey: `notice_served:${result.id}:tenant`,
      data: noticeData,
    });
  }
  if (parties?.landlord_sub) {
    await notify({
      leaseId,
      to: { sub: parties.landlord_sub, email: parties.landlord_email },
      kind: 'notice_served',
      dedupeKey: `notice_served:${result.id}:landlord`,
      data: noticeData,
    });
  }

  await audit({
    actorSub: access.person.sub,
    actorRole: access.isLandlord ? 'landlord' : 'tenant',
    action: 'termination.notice_served',
    entity: 'termination',
    entityId: result.id,
    detail: {
      reason: input.reason,
      initiatedBy: input.initiatedBy,
      noticeGivenOn,
      effectiveOn: result.effectiveOn,
      invoicesAdjusted: result.invoicesAdjusted,
    },
  });

  return json(201, result);
});
