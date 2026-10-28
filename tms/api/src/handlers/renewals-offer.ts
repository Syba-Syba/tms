import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, parseBody, route } from '../lib/http';
import { offerRenewalSchema, renewalTerms } from '../domain/renewal';
import { rentForPeriod, zar } from '../domain/money';
import { dateFromIso, sastToday } from '../domain/dates';
import { notify } from '../lib/notify';

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord offers a renewal.');
  const input = parseBody(event, offerRenewalSchema);

  const result = await withTransaction(async (run) => {
    const [lease] = await run<{
      status: string; start_date: string; end_date: string; monthly_rent_cents: string; escalation_pct: string;
      escalates_from: string | null;
    }>(
      `select status, start_date::text, end_date::text, monthly_rent_cents, escalation_pct, escalates_from::text
         from lease where id = $1 for update`,
      [leaseId],
    );
    if (!lease) throw badRequest('That lease no longer exists.');
    if (lease.status !== 'active') throw conflict(`This lease is ${lease.status}.`);

    const [notice] = await run<{ id: string }>(
      `select id from termination where lease_id = $1 and status <> 'withdrawn'`,
      [leaseId],
    );
    if (notice) throw conflict('Notice has been served on this lease, so there is nothing to renew.');

    // The deposit already held, interest included, decides how big the top-up needs to be.
    const [held] = await run<{ balance: string }>(
      `select coalesce(sum(case entry_type
                when 'received' then amount_cents when 'interest' then amount_cents
                else -amount_cents end), 0)::text as balance
         from deposit_ledger where lease_id = $1`,
      [leaseId],
    );

    const escalation = input.escalationPct ?? Number(lease.escalation_pct);
    // The rent payable in the lease's final month, not the figure it started on. Escalating
    // the base rent gave a two-year lease a renewal at no increase at all.
    const currentRentCents = rentForPeriod(
      Number(lease.monthly_rent_cents),
      Number(lease.escalation_pct),
      dateFromIso(lease.escalates_from ?? lease.start_date),
      dateFromIso(lease.end_date),
    );
    const terms = renewalTerms({
      currentEndDate: new Date(lease.end_date),
      currentRentCents,
      escalationPct: escalation,
      termMonths: input.termMonths,
      depositHeldCents: Number(held?.balance ?? 0),
      // The South African date, so an offer made just after midnight is not dated yesterday.
      offeredOn: dateFromIso(sastToday()),
      respondDays: input.respondDays,
    });
    // A landlord may name a figure instead of taking the escalation, but the deposit has to
    // follow it, otherwise the security drifts below the rent it secures.
    const rent = input.newRentCents ?? terms.newRentCents;
    const topUp = Math.max(0, rent - Number(held?.balance ?? 0));

    const [renewal] = await run<{ id: string }>(
      `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date,
                            new_rent_cents, escalation_pct, deposit_top_up_cents)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (lease_id) where status = 'offered' do nothing
       returning id`,
      [
        leaseId, terms.respondBy, input.termMonths ?? 12, terms.newStartDate, terms.newEndDate,
        rent, escalation, topUp,
      ],
    );
    if (!renewal) throw conflict('There is already an open renewal offer on this lease.');

    return {
      id: renewal.id,
      newStartDate: terms.newStartDate.toISOString().slice(0, 10),
      newEndDate: terms.newEndDate.toISOString().slice(0, 10),
      newRentCents: rent,
      depositTopUpCents: topUp,
      respondBy: terms.respondBy.toISOString().slice(0, 10),
    };
  });

  const [tenant] = await query<{ sub: string | null; email: string; phone: string; unit: string }>(
    `select a.cognito_sub as sub, a.email, a.phone, p.name || ' ' || u.code as unit
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where l.id = $1`,
    [leaseId],
  );
  if (tenant?.sub) {
    await notify({
      leaseId,
      to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
      kind: 'renewal_offered',
      dedupeKey: `renewal_offered:${result.id}`,
      data: {
        unit: tenant.unit,
        newRent: zar(result.newRentCents),
        startDate: result.newStartDate,
        endDate: result.newEndDate,
        respondBy: result.respondBy,
        topUpLine:
          result.depositTopUpCents > 0
            ? `Your deposit needs topping up by ${zar(result.depositTopUpCents)} to match the new rent. The interest already earned stays yours and keeps running.`
            : 'Your deposit already covers the new rent, so there is nothing more to pay on it.',
      },
    });
  }

  await audit({
    actorSub: access.person.sub,
    actorRole: 'landlord',
    action: 'renewal.offered',
    entity: 'renewal',
    entityId: result.id,
    detail: { newRentCents: result.newRentCents, respondBy: result.respondBy },
  });

  return json(201, result);
});
