import { randomUUID } from 'node:crypto';
import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import {
  incomingInspectionSql,
  outgoingCountsSql,
  outgoingInWindowSql,
  pickRefundRule,
  reconcile,
  refundDueBy,
  settleSchema,
} from '../domain/termination';
import { dateFromIso, isoDate, sastToday } from '../domain/dates';
import { renderExitStatementPdf, type ComparisonRow, type InspectionPhoto } from '../lib/pdf';
import { sniffImageType } from '../lib/images';
import { notify } from '../lib/notify';
import { zar } from '../domain/money';
import { logger } from '../lib/logger';
import { moveCreditToOpenInvoices } from '../lib/billing';
import { lockLease } from '../lib/payments';
import { invoiceStatus } from '../domain/charge';

/** A condition's rank, for the two-step wear-and-tear rule. A missing baseline ranks null, so
    the comparison is null and the deduction is not backed. */
const RANK_SQL = (expr: string) =>
  `(case ${expr} when 'good' then 0 when 'fair' then 1 when 'poor' then 2 when 'damaged' then 3 when 'missing' then 4 end)`;

/** The bytes decide whether a photo is a PNG or a JPEG. The key's extension used to, and a
    gallery PNG saved under a .jpg key made the statement render throw, blocking settlement. */
const photoOrNull = async (key: string | null): Promise<InspectionPhoto | null> => {
  if (!key) return null;
  try {
    const bytes = await storage().get(key);
    const type = sniffImageType(bytes);
    if (!type) {
      logger.warn('Comparison photo is not a PNG or JPEG; left out of the statement.', { key });
      return null;
    }
    return { bytes, type };
  } catch (error) {
    logger.warn('Comparison photo missing.', { key, error });
    return null;
  }
};

/** SQL true while the lease has a payment slip waiting for the landlord (or one still uploading).
    Settling first took the deposit for rent the slip had paid, and the slip could then never be
    accepted: nothing was owed any more. */
const pendingSlipsSql = (leaseExpr: string) =>
  `exists (select 1 from payment_proof pp
            where pp.lease_id = ${leaseExpr}
              and (pp.status = 'pending' or (pp.status = 'uploading' and pp.created_at > now() - interval '1 hour')))`;

const AWAITING_TENANT =
  'The landlord recorded this notice and the tenant has not confirmed it yet. The deposit is settled once they do.';
const PENDING_SLIPS = 'Accept or reject the tenant’s payment slips before settling the deposit.';

type Deduction = {
  id: string; description: string; amount_cents: string; finding_id: string | null; still_backed: boolean | null;
};

/**
 * Each deduction, checked against the findings as they stand now: one added while the exit
 * inspection was open survived its finding being corrected to fair wear and tear, or the
 * inspection being replaced by a rebooking.
 */
const readDeductions = (run: SettleRun, terminationId: string) =>
  run<Deduction>(
    `select d.id, d.description, d.amount_cents, d.finding_id,
            case when d.finding_id is null then null else exists (
              select 1 from inspection_finding f
                join inspection i on i.id = f.inspection_id
                join termination t on t.id = d.termination_id and t.lease_id = i.lease_id
               where f.id = d.finding_id and ${outgoingInWindowSql('i', 't')}
                 and f.condition in ('poor', 'damaged', 'missing')
                 and ${RANK_SQL('f.condition')} - ${RANK_SQL(`(select inc.condition from inspection_finding inc
                      where inc.inspection_id = ${incomingInspectionSql('t.lease_id')}
                        and inc.room = f.room and inc.item = f.item)`)} >= 2
            ) end as still_backed
       from deposit_deduction d where d.termination_id = $1 order by d.created_at, d.id`,
    [terminationId],
  );

/**
 * The figures a settlement rests on: the deposit held, the claims against it, the refund rule
 * and its due date. Shared by the settlement and its preview, so the dialog shows the landlord
 * the exact amount the statement will carry.
 */
export async function settlementFigures(terminationId: string, today: string, restoredOn?: Date) {
  const [context] = await query<{
    lease_id: string;
    status: string;
    effective_on: string;
    reason: string;
    penalty_cents: string;
    lease_ref: string;
    tenant: string;
    unit_label: string;
    trading_name: string;
    outgoing_completed: boolean;
    awaiting_tenant: boolean;
    pending_slips: boolean;
  }>(
    `select t.lease_id, t.status, t.effective_on::text, t.reason, t.penalty_cents,
            (t.needs_tenant_confirmation and t.tenant_confirmed_at is null) as awaiting_tenant,
            ${pendingSlipsSql('t.lease_id')} as pending_slips,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
            a.first_name || ' ' || a.last_name as tenant,
            p.name || ' ' || u.code as unit_label,
            ll.trading_name,
            -- RHA s5(3): a landlord who never inspects is deemed to accept the unit as it is. A
            -- tenant who was told the date and stayed away does not get that benefit: the
            -- landlord inspects alone, and a report the landlord signed after the date counts.
            -- Only for an inspection booked before its day (SAST), so the tenant was told: one
            -- created after the date could otherwise be signed alone to keep deductions.
            -- Only the exit inspection for the current end date counts: one held for an earlier
            -- date (before a month-to-month lease was given notice) is not the move-out.
            exists (select 1 from inspection i
                     where i.lease_id = t.lease_id and ${outgoingInWindowSql('i', 't')}
                       and ${outgoingCountsSql('i', '$2::date')})
              as outgoing_completed
       from termination t
       join lease l on l.id = t.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where t.id = $1`,
    [terminationId, today],
  );
  if (!context) throw notFound('Termination');
  if (context.status === 'settled') throw conflict('This deposit is already settled.');
  if (context.status === 'withdrawn') throw conflict('This notice was withdrawn, so the lease carries on.');

  // Restoration happens after the tenant leaves and before the deposit is settled. A date
  // outside that put the statutory 14 days anywhere the landlord liked.
  if (restoredOn) {
    const restored = isoDate(restoredOn);
    if (restored > today) throw badRequest('restoredOn cannot be in the future.', { restoredOn: `Use ${today} or earlier.` });
    if (restored < context.effective_on) {
      throw badRequest('restoredOn cannot be before the lease ended.', { restoredOn: `Use ${context.effective_on} or later.` });
    }
  }

  const deductions = await readDeductions(query, terminationId);
  const unbacked = deductions.filter((row) => row.still_backed === false).map((row) => row.description);

  // Skipping the outgoing inspection is deemed an acknowledgement of no damage, so the law
  // does not let the landlord keep anything for repairs afterwards.
  const rule = pickRefundRule({
    outgoingInspectionCompleted: context.outgoing_completed,
    deductionCount: deductions.length,
  });

  // A rent credit first offsets arrears; whatever is left goes back to the tenant.
  const balances = await readBalances(query, context.lease_id);
  const { grossArrears, rentCredit } = balances;

  // Anything already paid out or deducted has left the deposit and cannot be refunded twice.
  const alreadyOut = balances.alreadyOut;
  const summary = reconcile({
    depositCents: balances.deposit,
    interestCents: balances.interest,
    deductionsCents:
      deductions.reduce((sum, row) => sum + Number(row.amount_cents), 0) + alreadyOut,
    arrearsCents: Math.max(0, grossArrears - rentCredit),
    penaltyCents: Number(context.penalty_cents),
    rentCreditCents: Math.max(0, rentCredit - grossArrears),
  });

  // 14 days runs from restoration, the other two from the lease ending.
  const anchorIso = rule === 'with_deductions' ? (restoredOn ? isoDate(restoredOn) : today) : context.effective_on;
  const dueBy = refundDueBy(rule, dateFromIso(anchorIso));
  const blocker = context.awaiting_tenant
    ? AWAITING_TENANT
    : context.pending_slips
      ? PENDING_SLIPS
      : rule === 'no_inspection' && deductions.length > 0
        ? 'No outgoing inspection was completed, so nothing may be deducted. Remove the deductions or hold the inspection.'
        : unbacked.length > 0
          ? `The exit inspection no longer supports: ${unbacked.join(', ')}. Remove ${unbacked.length > 1 ? 'these deductions' : 'this deduction'} to settle.`
          : null;
  return { context, deductions, rule, balances, grossArrears, rentCredit, alreadyOut, summary, anchorIso, dueBy, blocker };
}

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
  const input = parseBody(event, settleSchema);
  const today = sastToday();

  const { context, deductions, rule, balances, grossArrears, rentCredit, alreadyOut, summary, anchorIso, dueBy, blocker } =
    await settlementFigures(terminationId, today, input.restoredOn);
  // Settling terminates the lease and vacates the unit, so doing it early would end a
  // tenancy that is still running. The deposit is reconciled once the tenant has moved out.
  if (today < context.effective_on) {
    throw conflict(
      `The lease runs until ${context.effective_on}. The deposit is settled after the tenant has moved out.`,
    );
  }
  if (blocker) throw conflict(blocker);

  const comparisons = await query<{
    room: string;
    item: string;
    incoming_condition: string;
    outgoing_condition: string;
    note: string | null;
    incoming_key: string | null;
    outgoing_key: string | null;
  }>(
    // The move-in baseline may sit on the lease a renewal replaced; the exit record is this
    // lease's live outgoing inspection for the current end date.
    `with insp as (
       select 'incoming' as kind, f.id, f.room, f.item, f.condition, f.note
         from inspection_finding f
        where f.inspection_id = ${incomingInspectionSql('$1')}
       union all
       select 'outgoing' as kind, f.id, f.room, f.item, f.condition, f.note
         from termination t
         join inspection i on i.lease_id = t.lease_id
         join inspection_finding f on f.inspection_id = i.id
        where t.id = $2 and ${outgoingInWindowSql('i', 't')}
     ),
     first_photo as (
       select distinct on (finding_id) finding_id, s3_key
         from inspection_photo where uploaded order by finding_id, uploaded_at
     )
     select out.room, out.item,
            coalesce(inc.condition, 'not recorded') as incoming_condition,
            out.condition as outgoing_condition, out.note,
            ip.s3_key as incoming_key, op.s3_key as outgoing_key
       from (select * from insp where kind = 'outgoing') out
       left join (select * from insp where kind = 'incoming') inc
         on out.room = inc.room and out.item = inc.item
       left join first_photo ip on ip.finding_id = inc.id
       left join first_photo op on op.finding_id = out.id
      where out.condition in ('poor', 'damaged', 'missing')
        and (inc.condition is null or out.condition <> inc.condition)
      order by out.room, out.item`,
    [context.lease_id, terminationId],
  );

  // Two photos per row, fetched row by row: the whole set at once was most of the memory
  // this handler used, for a document that only needs each pair briefly.
  const comparisonRows: ComparisonRow[] = [];
  for (const row of comparisons) {
    comparisonRows.push({
      room: row.room,
      item: row.item,
      incomingCondition: row.incoming_condition,
      outgoingCondition: row.outgoing_condition,
      note: row.note,
      incomingPhoto: await photoOrNull(row.incoming_key),
      outgoingPhoto: await photoOrNull(row.outgoing_key),
    });
  }

  const rendered = await renderExitStatementPdf({
    ref: `EXIT-${context.lease_ref}`,
    landlordName: context.trading_name,
    tenantName: context.tenant,
    unitLabel: context.unit_label,
    leaseEndOn: context.effective_on,
    reason: context.reason,
    depositCents: summary.depositCents,
    interestCents: summary.interestCents,
    arrearsCents: summary.arrearsCents,
    penaltyCents: summary.penaltyCents,
    rentCreditCents: summary.rentCreditCents,
    deductions: deductions.map((row) => ({
      description: row.description,
      amountCents: Number(row.amount_cents),
      backedBy: row.finding_id ? 'Inspection' : 'Deduction',
    })),
    refundCents: summary.refundCents,
    tenantOwesCents: summary.tenantOwesCents,
    refundRule: rule,
    refundDueBy: isoDate(dueBy),
    refundReference: input.refundReference ?? null,
    comparisons: comparisonRows,
  });

  // A key of its own per attempt: a second settle running alongside wrote over a shared key
  // after the first had committed. The hash alone is not enough: two renders in the same second
  // are byte-identical, so the loser's cleanup below would delete the winner's statement.
  const key = `terminations/${terminationId}/deposit-statement-${rendered.sha256}-${randomUUID()}.pdf`;
  await storage().put(key, rendered.bytes, 'application/pdf');

  try {
    await withTransaction(async (run) => {
      // The lease first, then the termination, then the invoices: the order every payment path
      // takes, so the two cannot deadlock. Held, no payment, slip or deposit money lands on this
      // lease until settlement commits, and the reads below see everything committed before.
      await lockLease(run, context.lease_id);
      const [locked] = await run<{
        status: string; awaiting_tenant: boolean; outgoing_completed: boolean; pending_slips: boolean;
      }>(
        `select t.status,
                (t.needs_tenant_confirmation and t.tenant_confirmed_at is null) as awaiting_tenant,
                exists (select 1 from inspection i
                         where i.lease_id = t.lease_id and ${outgoingInWindowSql('i', 't')}
                           and ${outgoingCountsSql('i', '$2::date')}) as outgoing_completed,
                ${pendingSlipsSql('t.lease_id')} as pending_slips
           from termination t where t.id = $1
           for update of t`,
        [terminationId, today],
      );
      if (!locked || locked.status === 'settled') throw conflict('This deposit is already settled.');
      if (locked.status === 'withdrawn') throw conflict('This notice was withdrawn, so the lease carries on.');
      if (locked.awaiting_tenant) throw conflict(AWAITING_TENANT);
      if (locked.pending_slips) throw conflict(PENDING_SLIPS);
      // The deductions and the inspection were read before the statement rendered. The
      // deduction handlers lock the termination row, so under that lock this read is final.
      const currentDeductions = await readDeductions(run, terminationId);
      const sameDeductions =
        currentDeductions.length === deductions.length &&
        currentDeductions.every(
          (row, index) =>
            row.id === deductions[index]!.id &&
            row.amount_cents === deductions[index]!.amount_cents &&
            row.still_backed !== false,
        );
      const currentRule = pickRefundRule({
        outgoingInspectionCompleted: locked.outgoing_completed,
        deductionCount: currentDeductions.length,
      });
      if (!sameDeductions || currentRule !== rule) {
        throw conflict('The deductions changed while the statement was prepared. Try again.');
      }
      // The figures above were read before the statement rendered, and a payment recorded in
      // that time was then taken off the deposit as arrears as well: the full stale arrears went
      // to the ledger while only what was still owing paid the invoices. The invoices are locked
      // so nothing more can land on them, and the statement is only good if nothing changed.
      const current = await readBalances(run, context.lease_id, true);
      if (
        current.grossArrears !== grossArrears ||
        current.rentCredit !== rentCredit ||
        current.deposit !== balances.deposit ||
        current.interest !== balances.interest ||
        current.alreadyOut !== alreadyOut
      ) {
        throw conflict('Payments changed while the statement was prepared. Try again.');
      }

      // The ledger is the record. Every claim and the payout land in it as entries, and they
      // must bring the held balance to zero: arrears and the penalty were missing from it, so
      // a settled lease kept a positive balance and the interest run went on crediting it.
      // Claims come off in the order repairs, arrears, penalty, and stop at what is held; the
      // rest is a debt the statement shows as owed by the tenant, never a negative ledger.
      let remaining = summary.heldCents - alreadyOut;
      const post = async (amount: number, note: string) => {
        const posted = Math.min(amount, Math.max(0, remaining));
        if (posted <= 0) return 0;
        // Dated in SAST, like the payments beside it; the database's current_date is UTC.
        await run(
          `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
           values ($1, 'deduction', $2, $3, $4)`,
          [context.lease_id, posted, today, note],
        );
        remaining -= posted;
        return posted;
      };
      // Repairs and the penalty that the deposit could not cover, so the shortfall can be billed.
      let unrecovered = 0;
      for (const deduction of deductions) {
        const amount = Number(deduction.amount_cents);
        unrecovered += amount - (await post(amount, deduction.description));
      }
      // Rent paid above a re-rated month's total is the tenant's credit, and the statement nets it
      // against arrears. The money has to move with it: left on the overpaid invoice, the unpaid
      // ones stayed open and the arrears ladder went on chasing rent the tenant did not owe.
      if (rentCredit > 0 && grossArrears > 0) await moveCreditToOpenInvoices(run, context.lease_id);
      if (summary.arrearsCents > 0) {
        // What came off the deposit for arrears pays the open invoices, oldest first. Left open,
        // the statement still showed the tenant owing rent the deposit had already covered.
        // The ledger records what was actually applied to them, never more.
        const open = await run<{ id: string; owing: string }>(
          `select i.id, (i.total_cents - coalesce((select sum(p.amount_cents) from payment p
                                                    where p.invoice_id = i.id), 0))::text as owing
             from invoice i
            where i.lease_id = $1 and i.status in ('issued', 'part_paid')
            order by i.due_on, i.period_start
            for update`,
          [context.lease_id],
        );
        const owing = open.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.owing)), 0);
        let applied = await post(Math.min(summary.arrearsCents, owing), 'Rent arrears');
        for (const invoice of open) {
          const amount = Math.min(applied, Number(invoice.owing));
          if (amount <= 0) continue;
          await run(
            `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
             values ($1, $2, $3, 'deposit', 'From the deposit at settlement', $4, $5)`,
            [context.lease_id, invoice.id, amount, today, access.person.sub],
          );
          await run('update invoice set status = $2 where id = $1', [
            invoice.id,
            amount === Number(invoice.owing) ? 'paid' : 'part_paid',
          ]);
          applied -= amount;
        }
      }
      if (summary.penaltyCents > 0) {
        unrecovered += summary.penaltyCents - (await post(summary.penaltyCents, 'Cancellation penalty'));
      }
      // The rent credit left after arrears is settled here too: refunded with the deposit, or set
      // against what the tenant owes on it. Left on the overpaid invoices, the rent statement went
      // on showing the landlord owing it after it had been paid back. It is recorded as a refund
      // against each overpaid invoice, which brings the rent account to zero.
      if (summary.rentCreditCents > 0) {
        await refundRentCredit(run, context.lease_id, summary.rentCreditCents, today, access.person.sub,
          summary.refundCents > 0 ? 'Rent credit refunded at settlement' : 'Rent credit set against the deposit statement');
      }
      // What the deposit did not cover is a debt. Shown only on the statement, it could not be
      // paid (nothing was owed), and the arrears ladder and age analysis never saw it. It goes
      // on an invoice. Any rent credit left was set against it on the statement; unpaid arrears
      // already sit on their own invoices. Billed after the credit refund: before it, the line would
      // soak up the latest invoice's overpayment and the credit would count twice.
      const shortfall = Math.min(summary.tenantOwesCents, Math.max(0, unrecovered - summary.rentCreditCents));
      if (shortfall > 0) await billShortfall(run, context.lease_id, shortfall, today);
      // Only the deposit's share of the refund leaves the deposit; a rent credit is the
      // landlord's own money, so it is on the statement but not in the ledger.
      const fromDeposit = Math.min(summary.refundCents, Math.max(0, remaining));
      if (fromDeposit > 0) {
        await run(
          `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
           values ($1, 'refund', $2, $3, $4)`,
          [context.lease_id, fromDeposit, today, input.refundReference ?? 'Refund on termination'],
        );
      }

      await run(
        `update termination
            set status = 'settled', refund_rule = $2, refund_anchor_on = $3, refund_due_by = $4,
                settled_at = now(), statement_s3_key = $5, statement_sha256 = $6, refund_cents = $7
          where id = $1`,
        [terminationId, rule, anchorIso, isoDate(dueBy), key, rendered.sha256, summary.refundCents],
      );
      await run("update lease set status = 'terminated' where id = $1", [context.lease_id]);
      await run(
        "update unit set status = 'vacant' where id = (select unit_id from lease where id = $1)",
        [context.lease_id],
      );
      // An open ticket on a lease nobody lives in is noise. That includes tickets left on the
      // leases a renewal replaced: the SLA sweep went on reporting them breached every day.
      await run(
        `with recursive chain(id, depth) as (
           select $1::uuid, 0
           union all
           select l.previous_lease_id, chain.depth + 1
             from chain join lease l on l.id = chain.id
            where l.previous_lease_id is not null and chain.depth < 50
         )
         update ticket set status = 'cancelled'
          where lease_id in (select id from chain) and status not in ('closed', 'cancelled')`,
        [context.lease_id],
      );
      await audit(
        {
          actorSub: access.person.sub,
          actorRole: 'landlord',
          action: 'termination.settled',
          entity: 'termination',
          entityId: terminationId,
          detail: { rule, refundCents: summary.refundCents, tenantOwesCents: summary.tenantOwesCents, dueBy: isoDate(dueBy) },
        },
        run,
      );
    });
  } catch (error) {
    // Nothing settled, so the statement written for it is no one's record.
    await storage().remove(key).catch((removeError: unknown) =>
      logger.warn('Unused exit statement left in storage.', { key, error: removeError }));
    throw error;
  }

  // Settled. A failure from here on is logged, not returned: a 500 now would invite a retry
  // of something that has already happened.
  try {
    const [tenant] = await query<{ sub: string | null; email: string; phone: string }>(
      // A tenant imported without an account is addressed by their applicant row.
      `select coalesce(a.cognito_sub, 'applicant:' || a.id) as sub, a.email, a.phone
         from lease l join applicant a on a.id = l.applicant_id where l.id = $1`,
      [context.lease_id],
    );
    if (tenant?.sub) {
      const owing = summary.tenantOwesCents > 0;
      await notify({
        leaseId: context.lease_id,
        to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
        kind: 'deposit_settled',
        dedupeKey: `deposit_settled:${terminationId}`,
        data: {
          unit: context.unit_label,
          headline: owing ? `${zar(summary.tenantOwesCents)} owed` : `${zar(summary.refundCents)} refund`,
          breakdown: [
            `Deposit ${zar(summary.depositCents)}`,
            `Interest ${zar(summary.interestCents)}`,
            // Part of the refund, so the lines add up to the headline.
            summary.rentCreditCents > 0 ? `Plus rent paid in advance ${zar(summary.rentCreditCents)}` : null,
            summary.deductionsCents > 0 ? `Less repairs ${zar(summary.deductionsCents)}` : null,
            summary.arrearsCents > 0 ? `Less arrears ${zar(summary.arrearsCents)}` : null,
            summary.penaltyCents > 0 ? `Less cancellation penalty ${zar(summary.penaltyCents)}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          dueBy: isoDate(dueBy),
        },
      });
    }
  } catch (error) {
    logger.error('Deposit settled but the statement notice could not be queued.', { terminationId, error });
  }

  return json(200, {
    ...summary,
    refundRule: rule,
    refundDueBy: isoDate(dueBy),
    statementKey: key,
    statementSha256: rendered.sha256,
  });
});

type SettleRun = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * The deposit held and what the tenant owes or is owed in rent. Each open invoice less what was
 * paid against it: netting every payment on the lease against every invoice overstated arrears
 * whenever a paid invoice sat beside an unpaid one. Rent paid above an invoice's total is a
 * credit, a fully paid month that a notice later cut short. With `lock`, the invoices are held
 * for update, so no payment can land on them before the caller's transaction ends.
 */
async function readBalances(run: SettleRun, leaseId: string, lock = false) {
  const [ledger] = await run<{ deposit: string; interest: string; already_out: string }>(
    `select coalesce(sum(amount_cents) filter (where entry_type = 'received'), 0)::text as deposit,
            coalesce(sum(amount_cents) filter (where entry_type = 'interest'), 0)::text as interest,
            coalesce(sum(amount_cents) filter (where entry_type in ('deduction', 'refund')), 0)::text
              as already_out
       from deposit_ledger where lease_id = $1`,
    [leaseId],
  );
  const invoices = await run<{ status: string; owed: string }>(
    `select i.status, (i.total_cents - coalesce((select sum(p.amount_cents) from payment p
                                                 where p.invoice_id = i.id), 0))::text as owed
       from invoice i
      where i.lease_id = $1 and i.status in ('issued', 'part_paid', 'paid')
      order by i.id
      ${lock ? 'for update' : ''}`,
    [leaseId],
  );
  let grossArrears = 0;
  let rentCredit = 0;
  for (const invoice of invoices) {
    const owed = Number(invoice.owed);
    if (owed > 0 && invoice.status !== 'paid') grossArrears += owed;
    if (owed < 0) rentCredit -= owed;
  }
  return {
    deposit: Number(ledger?.deposit ?? 0),
    interest: Number(ledger?.interest ?? 0),
    alreadyOut: Number(ledger?.already_out ?? 0),
    grossArrears,
    rentCredit,
  };
}

/**
 * Bills what the tenant still owes after the deposit as an 'other' line on the lease's latest
 * invoice, or on a new invoice due today when there is none, so it can be paid and chased.
 */
async function billShortfall(run: SettleRun, leaseId: string, amountCents: number, today: string): Promise<void> {
  const description = 'Owed after the deposit: repairs and cancellation penalty';
  const [latest] = await run<{ id: string }>(
    `select id from invoice where lease_id = $1 and status <> 'void' order by period_start desc limit 1 for update`,
    [leaseId],
  );
  if (latest) {
    await run(`insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'other', $2, $3)`,
      [latest.id, description, amountCents]);
    const [row] = await run<{ total: string; paid: string }>(
      `update invoice set total_cents = total_cents + $2 where id = $1
       returning total_cents::text as total,
                 coalesce((select sum(amount_cents) from payment where invoice_id = $1), 0)::text as paid`,
      [latest.id, amountCents],
    );
    await run('update invoice set status = $2 where id = $1', [latest.id, invoiceStatus(Number(row!.paid), Number(row!.total))]);
    return;
  }
  const [created] = await run<{ id: string }>(
    `insert into invoice (lease_id, period_start, due_on, total_cents, status)
     values ($1, date_trunc('month', $2::date)::date, $2::date, $3, 'issued')
     on conflict (lease_id, period_start) do nothing
     returning id`,
    [leaseId, today, amountCents],
  );
  if (!created) {
    logger.warn('Shortfall after the deposit not billed: the month holds a void invoice.', { leaseId, amountCents });
    return;
  }
  await run(`insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'other', $2, $3)`,
    [created.id, description, amountCents]);
}

/**
 * Records `amountCents` of rent credit as paid back, as negative 'refund' payments against the
 * invoices paid above their total, most recent first, never more than each one's excess.
 */
async function refundRentCredit(
  run: SettleRun,
  leaseId: string,
  amountCents: number,
  today: string,
  recordedBy: string,
  reference: string,
): Promise<void> {
  const overpaid = await run<{ id: string; excess: string }>(
    `select i.id,
            (coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0) - i.total_cents)::text as excess
       from invoice i
      where i.lease_id = $1 and i.status in ('issued', 'part_paid', 'paid')
        and coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0) > i.total_cents
      order by i.period_start desc`,
    [leaseId],
  );
  let left = amountCents;
  for (const invoice of overpaid) {
    const amount = Math.min(left, Number(invoice.excess));
    if (amount <= 0) continue;
    await run(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, $3, 'refund', $4, $5, $6)`,
      [leaseId, invoice.id, -amount, reference, today, recordedBy],
    );
    left -= amount;
    if (left === 0) break;
  }
  if (left > 0) logger.warn('Rent credit larger than the overpaid invoices; the rest is not recorded.', { leaseId, left });
}
