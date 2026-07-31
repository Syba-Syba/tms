import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, parseBody, route } from '../lib/http';
import { earliestEffectiveDate, NOTICE_BUSINESS_DAYS, serveNoticeSchema } from '../domain/termination';
import { notify } from '../lib/notify';
import { query } from '../lib/db';

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  const input = parseBody(event, serveNoticeSchema);
  const penaltyCents = input.penaltyCents ?? 0;

  // You may only serve notice as yourself. Mutual needs both, so the landlord records it.
  if (input.initiatedBy === 'tenant' && !access.isTenant) {
    throw forbidden('Only the tenant serves the tenant\u2019s notice.');
  }
  if (input.initiatedBy !== 'tenant' && !access.isLandlord) {
    throw forbidden('Only the landlord records this notice.');
  }
  // A penalty is a landlord's charge under CPA s14. A tenant cannot set one on themselves.
  if (penaltyCents > 0 && !access.isLandlord) {
    throw forbidden('Only the landlord sets a cancellation penalty.');
  }

  const result = await withTransaction(async (run) => {
    const [lease] = await run<{ status: string; end_date: string }>(
      'select status, end_date::text from lease where id = $1 for update',
      [leaseId],
    );
    if (!lease) throw badRequest('That lease no longer exists.');
    if (lease.status !== 'active') throw conflict(`This lease is ${lease.status}.`);

    const leaseEnd = new Date(lease.end_date);
    const earliest = earliestEffectiveDate(input.reason, input.noticeGivenOn, leaseEnd);
    const effective = input.effectiveOn ?? earliest;
    // The parties may agree a later date than the minimum, never an earlier one.
    if (effective < earliest) {
      throw badRequest(
        `The earliest lawful end date is ${earliest.toISOString().slice(0, 10)}. ` +
          `${NOTICE_BUSINESS_DAYS[input.reason]} business days\u2019 notice applies.`,
      );
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
        input.noticeGivenOn,
        effective,
        NOTICE_BUSINESS_DAYS[input.reason],
        penaltyCents,
      ],
    );
    if (!termination) throw conflict('Notice has already been served on this lease.');

    return {
      id: termination.id,
      effectiveOn: effective.toISOString().slice(0, 10),
      earliestLawful: earliest.toISOString().slice(0, 10),
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
    noticeGivenOn: input.noticeGivenOn.toISOString().slice(0, 10),
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
    detail: { reason: input.reason, effectiveOn: result.effectiveOn },
  });

  return json(201, result);
});
