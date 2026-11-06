import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, parseBody, route } from '../lib/http';
import {
  businessDaysBetween,
  earliestEffectiveDate,
  LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS,
  landlordEndOfTermServableFrom,
  latestEffectiveDate,
  maxCancellationPenaltyCents,
  noticeBusinessDays,
  serveNoticeSchema,
  type TerminationReason,
} from '../domain/termination';
import { addDaysIso, dateFromIso, isoDate, sastToday } from '../domain/dates';
import { movePendingChargesPast, trimInvoicesAfter } from '../lib/billing';
import { notify } from '../lib/notify';
import { query } from '../lib/db';
import { rentForPeriod, zar } from '../domain/money';

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

/** A landlord may record a tenant's paper notice received a little while ago, not rewrite last year. */
const LANDLORD_BACKDATE_DAYS = 30;

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  const input = parseBody(event, serveNoticeSchema);
  const penaltyCents = input.penaltyCents ?? 0;

  // A tenant serves their own notice in the app. A tenant who gave it on paper or by email
  // (CPA s14 needs it in writing, not in this app) has it recorded by the landlord, dated the
  // day it was received. Without that, a tenant cancelling early by letter could not be
  // entered at all. Mutual needs both: the landlord records it and the tenant confirms it.
  if (input.initiatedBy === 'tenant' && !access.isTenant && !access.isLandlord) {
    throw forbidden('Only the tenant or the landlord records the tenant’s notice.');
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
  // CPA s14(3)(b) allows a penalty for cancelling a fixed term early, nothing else. A lease
  // that runs to term, or ends on a breach, carries none.
  if (penaltyCents > 0 && input.reason !== 'early_tenant') {
    throw badRequest('A cancellation penalty only applies when the tenant cancels early.', {
      penaltyCents: 'Leave it at zero for this reason.',
    });
  }

  const today = sastToday();
  // The tenant's notice is given the moment it is served; the clock cannot be wound back.
  // Only a tenant's notice the landlord received on paper may carry an earlier date. The
  // landlord's own notice, and a mutual one, is given today: dating it back shortened the
  // notice the CPA gives the tenant by however many days it was backdated.
  const noticeGivenOn =
    access.isTenant && !access.isLandlord ? today : input.noticeGivenOn ? isoDate(input.noticeGivenOn) : today;
  if (noticeGivenOn > today) throw badRequest('The notice date cannot be in the future.');
  if (noticeGivenOn < today && input.initiatedBy !== 'tenant') {
    throw badRequest('A landlord’s or a mutual notice is given today. Only a tenant’s written notice can be recorded with an earlier date.', {
      noticeGivenOn: `Use today, ${today}.`,
    });
  }
  if (noticeGivenOn < addDaysIso(today, -LANDLORD_BACKDATE_DAYS)) {
    throw badRequest(`A notice can be recorded up to ${LANDLORD_BACKDATE_DAYS} days after it was given, not earlier.`);
  }
  // A mutual or tenant's notice entered by the landlord rests on the landlord's word alone,
  // whatever its date: dated today it still ended a fixed term, and carried a penalty, without
  // the tenant agreeing. The tenant confirms it in the app before the deposit is settled; until
  // then the tenant may refuse it and the landlord may withdraw their own entry.
  const recordedByTenant = access.isTenant && !access.isLandlord;
  const needsTenantConfirmation = !recordedByTenant && input.initiatedBy !== 'landlord';

  const result = await withTransaction(async (run) => {
    const [lease] = await run<{
      status: string; end_date: string; start_date: string; escalates_from: string | null;
      monthly_rent_cents: string; escalation_pct: string; has_account: boolean;
    }>(
      `select l.status, l.end_date::text, l.start_date::text, l.escalates_from::text,
              l.monthly_rent_cents::text, l.escalation_pct::text,
              (select a.cognito_sub is not null from applicant a where a.id = l.applicant_id) as has_account
         from lease l where l.id = $1 for update`,
      [leaseId],
    );
    if (!lease) throw badRequest('That lease no longer exists.');
    if (lease.status !== 'active') throw conflict(`This lease is ${lease.status}.`);
    // A tenant imported without an account cannot confirm, so the notice would never stand
    // and the deposit could never be settled.
    if (needsTenantConfirmation && !lease.has_account) {
      throw conflict(
        'The tenant has to confirm this notice in the app, and they have no account yet. ' +
          'Invite them to the app first, then record the notice.',
      );
    }

    // An accepted renewal takes over from this lease on its start date and moves the tenant
    // across. A notice here was lost at that handover and the tenant billed under the new
    // lease, so the two cannot both stand. Once both parties have signed the renewal it is a
    // binding lease, and the notice is refused. Until then it is only an acceptance: it is
    // cancelled with the notice. Refusing that too left a tenant who accepted and changed their
    // mind with no way out at all, since an unsigned scheduled lease cannot be cancelled.
    const [renewed] = await run<{ id: string; start_date: string; signed: boolean }>(
      `select l.id, l.start_date::text,
              (select count(*) from lease_signature s where s.lease_id = l.id) = 2 as signed
         from lease l where l.previous_lease_id = $1 and l.status = 'scheduled' for update`,
      [leaseId],
    );
    if (renewed?.signed) {
      throw conflict(
        `A renewal of this lease has been signed and starts on ${renewed.start_date}, so notice ` +
          'cannot be served on it. Once the new lease starts, notice is given on that one.',
      );
    }

    const notice = dateFromIso(noticeGivenOn);
    const leaseEnd = dateFromIso(lease.end_date);
    // CPA s14(2)(c): 40 to 80 business days before expiry. Served earlier, it is not the notice
    // the Act asks for, and the tenant would forget it long before the end date.
    if (
      input.initiatedBy === 'landlord' &&
      input.reason === 'end_of_term' &&
      leaseEnd > notice &&
      businessDaysBetween(notice, leaseEnd) > LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS
    ) {
      throw badRequest(
        `An end-of-term notice is given no more than ${LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS} business days ` +
          `before the lease ends. It can be served from ${isoDate(landlordEndOfTermServableFrom(leaseEnd))}.`,
      );
    }
    const noticeDays = noticeBusinessDays(input.reason, notice, leaseEnd, input.initiatedBy);
    const earliest = earliestEffectiveDate(input.reason, notice, leaseEnd, input.initiatedBy);
    const latest = latestEffectiveDate(input.reason, notice, leaseEnd, input.initiatedBy);
    // With no date chosen, the earliest lawful day, or today when a backdated notice's earliest
    // day has already passed: the form leaves the date optional, and it was refused below.
    const todayDate = dateFromIso(today);
    const effective = input.effectiveOn
      ? dateFromIso(isoDate(input.effectiveOn))
      : earliest < todayDate ? todayDate : earliest;
    // The parties may agree a later date than the minimum, never an earlier one.
    if (effective < earliest) {
      throw badRequest(
        `The earliest lawful end date is ${isoDate(earliest)}. ` +
          `${noticeDays} business days’ notice applies.`,
      );
    }
    // Nor one far off: a notice dated years ahead kept the lease live and the deposit
    // unsettled until then, and the termination cannot be replaced.
    if (effective > latest) {
      throw badRequest(`The latest end date for this notice is ${isoDate(latest)}.`);
    }
    // Nor can a lease end before today: the tenancy that ran until now happened.
    if (isoDate(effective) < today) {
      throw badRequest(`The end date cannot be before today (${today}).`);
    }
    // CPA s14(3)(b): the penalty is for cancelling a fixed term before it expires. A lease
    // already month to month, or a notice that runs to the end date anyway, cuts nothing short.
    if (penaltyCents > 0 && (leaseEnd <= notice || effective >= leaseEnd)) {
      throw badRequest('A cancellation penalty applies only when a fixed term is cancelled before its end date.', {
        penaltyCents: 'Leave it at zero.',
      });
    }
    // CPA s14(3)(b) and Reg 5(3): only a reasonable penalty.
    // Rated at the rent in force when the notice takes effect, after any escalation; an imported
    // lease escalates from when its stated rent took effect, as the invoice run does.
    const rentNow = rentForPeriod(Number(lease.monthly_rent_cents), Number(lease.escalation_pct),
      dateFromIso(lease.escalates_from ?? lease.start_date), effective);
    const maxPenalty = maxCancellationPenaltyCents(rentNow, effective, leaseEnd);
    if (penaltyCents > maxPenalty) {
      throw badRequest(
        `The cancellation penalty can be at most ${zar(maxPenalty)}: one month’s rent, or the rent for the rest of the term if that is less.`,
        { penaltyCents: `Use ${zar(maxPenalty)} or less.` },
      );
    }

    const [termination] = await run<{ id: string }>(
      `insert into termination
         (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days, penalty_cents,
          needs_tenant_confirmation)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (lease_id) where status <> 'withdrawn' do nothing
       returning id`,
      [
        leaseId,
        input.initiatedBy,
        input.reason,
        noticeGivenOn,
        isoDate(effective),
        noticeDays,
        penaltyCents,
        needsTenantConfirmation,
      ],
    );
    if (!termination) throw conflict('Notice has already been served on this lease.');

    // An offer to renew a lease that is ending lapses with the notice; accepting it afterwards
    // would start a new lease the tenant has just said they are leaving.
    // Both are recorded on the notice, so withdrawing it can put them back.
    const lapsed = await run<{ id: string }>(
      `update renewal set status = 'lapsed' where lease_id = $1 and status = 'offered' returning id`,
      [leaseId],
    );
    if (renewed) {
      await run(`update lease set status = 'cancelled' where id = $1`, [renewed.id]);
      lapsed.push(
        ...(await run<{ id: string }>(
          `update renewal set status = 'lapsed' where new_lease_id = $1 and status = 'accepted' returning id`,
          [renewed.id],
        )),
      );
    }
    await run('update termination set lapsed_renewal_ids = $2, cancelled_lease_id = $3 where id = $1', [
      termination.id,
      lapsed.map((row) => row.id),
      renewed?.id ?? null,
    ]);

    // Next month's rent may already have been invoiced in full on the 25th.
    const trimmed = await trimInvoicesAfter(run, leaseId, isoDate(effective));
    // A charge already added for a month after the lease now ends would never be billed: the
    // invoice run stops at the last month. It goes on the last invoice instead.
    const chargesMoved = await movePendingChargesPast(run, leaseId, isoDate(effective));

    return {
      id: termination.id,
      effectiveOn: isoDate(effective),
      earliestLawful: isoDate(earliest),
      noticeGivenOn,
      invoicesAdjusted: trimmed,
      chargesMoved,
      renewalCancelled: renewed?.id ?? null,
      awaitingTenant: needsTenantConfirmation,
    };
  });

  const [parties] = await query<{
    unit: string; tenant_sub: string; tenant_email: string; tenant_phone: string;
    landlord_sub: string | null; landlord_email: string;
  }>(
    `select p.name || ' ' || u.code as unit,
            -- A tenant imported without an account is addressed by their applicant row.
            coalesce(a.cognito_sub, 'applicant:' || a.id) as tenant_sub, a.email as tenant_email, a.phone as tenant_phone,
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
    // The tenant sees any penalty before confirming the notice it rides on.
    penaltyLine: penaltyCents > 0 ? `\n\nIt carries a cancellation penalty of ${zar(penaltyCents)}, taken from the deposit at settlement.` : '',
  };
  // Both parties, because the exit inspection deadline binds both of them.
  if (parties?.tenant_sub) {
    await notify({
      leaseId,
      to: { sub: parties.tenant_sub, email: parties.tenant_email, phone: parties.tenant_phone },
      kind: needsTenantConfirmation ? 'notice_confirm_requested' : 'notice_served',
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
      recordedBy: recordedByTenant ? 'tenant' : 'landlord',
      needsTenantConfirmation,
      reason: input.reason,
      initiatedBy: input.initiatedBy,
      noticeGivenOn,
      effectiveOn: result.effectiveOn,
      invoicesAdjusted: result.invoicesAdjusted,
    },
  });

  return json(201, result);
});
