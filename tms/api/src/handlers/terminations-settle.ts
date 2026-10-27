import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { pickRefundRule, reconcile, refundDueBy, settleSchema } from '../domain/termination';
import { dateFromIso, isoDate, sastToday } from '../domain/dates';
import { renderExitStatementPdf, type ComparisonRow, type InspectionPhoto } from '../lib/pdf';
import { sniffImageType } from '../lib/images';
import { notify } from '../lib/notify';
import { zar } from '../domain/money';
import { logger } from '../lib/logger';

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
  }>(
    `select t.lease_id, t.status, t.effective_on::text, t.reason, t.penalty_cents,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
            a.first_name || ' ' || a.last_name as tenant,
            p.name || ' ' || u.code as unit_label,
            ll.trading_name,
            -- RHA s5(3): a landlord who never inspects is deemed to accept the unit as it is. A
            -- tenant who was told the date and stayed away does not get that benefit: the
            -- landlord inspects alone, and a report the landlord signed after the date counts.
            exists (select 1 from inspection i
                     where i.lease_id = t.lease_id and i.kind = 'outgoing'
                       and (i.status = 'completed'
                            or (i.scheduled_for < $2::date
                                and exists (select 1 from inspection_signature s
                                             where s.inspection_id = i.id and s.party = 'landlord')
                                and not exists (select 1 from inspection_signature s
                                                 where s.inspection_id = i.id and s.party = 'tenant'))))
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
  // Settling terminates the lease and vacates the unit, so doing it early would end a
  // tenancy that is still running. The deposit is reconciled once the tenant has moved out.
  if (today < context.effective_on) {
    throw conflict(
      `The lease runs until ${context.effective_on}. The deposit is settled after the tenant has moved out.`,
    );
  }

  const deductions = await query<{ description: string; amount_cents: string; finding_id: string | null }>(
    'select description, amount_cents, finding_id from deposit_deduction where termination_id = $1 order by created_at',
    [terminationId],
  );

  // Skipping the outgoing inspection is deemed an acknowledgement of no damage, so the law
  // does not let the landlord keep anything for repairs afterwards.
  const rule = pickRefundRule({
    outgoingInspectionCompleted: context.outgoing_completed,
    deductionCount: deductions.length,
  });
  if (rule === 'no_inspection' && deductions.length > 0) {
    throw conflict(
      'No outgoing inspection was completed, so nothing may be deducted. Remove the deductions or hold the inspection.',
    );
  }

  const [ledger] = await query<{ deposit: string; interest: string; already_out: string }>(
    `select coalesce(sum(amount_cents) filter (where entry_type = 'received'), 0)::text as deposit,
            coalesce(sum(amount_cents) filter (where entry_type = 'interest'), 0)::text as interest,
            coalesce(sum(amount_cents) filter (where entry_type in ('deduction', 'refund')), 0)::text
              as already_out
       from deposit_ledger where lease_id = $1`,
    [context.lease_id],
  );
  // Each open invoice less what was paid against it. Netting every payment on the lease
  // against every invoice overstated arrears whenever a paid invoice sat beside an unpaid one.
  const [outstanding] = await query<{ arrears: string }>(
    `select coalesce(sum(i.total_cents - coalesce((select sum(p.amount_cents) from payment p
                                                    where p.invoice_id = i.id), 0)), 0)::text as arrears
       from invoice i
      where i.lease_id = $1 and i.status in ('issued', 'part_paid')`,
    [context.lease_id],
  );

  // Anything already paid out or deducted has left the deposit and cannot be refunded twice.
  const alreadyOut = Number(ledger?.already_out ?? 0);
  const summary = reconcile({
    depositCents: Number(ledger?.deposit ?? 0),
    interestCents: Number(ledger?.interest ?? 0),
    deductionsCents:
      deductions.reduce((sum, row) => sum + Number(row.amount_cents), 0) + alreadyOut,
    arrearsCents: Math.max(0, Number(outstanding?.arrears ?? 0)),
    penaltyCents: Number(context.penalty_cents),
  });

  // 14 days runs from restoration, the other two from the lease ending.
  const anchorIso = rule === 'with_deductions' ? (input.restoredOn ? isoDate(input.restoredOn) : today) : context.effective_on;
  const dueBy = refundDueBy(rule, dateFromIso(anchorIso));

  const comparisons = await query<{
    room: string;
    item: string;
    incoming_condition: string;
    outgoing_condition: string;
    note: string | null;
    incoming_key: string | null;
    outgoing_key: string | null;
  }>(
    `with insp as (
       select i.kind, f.id, f.room, f.item, f.condition, f.note
         from inspection i
         join inspection_finding f on f.inspection_id = i.id
        where i.lease_id = $1
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
    [context.lease_id],
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

  const key = `terminations/${terminationId}/deposit-statement.pdf`;
  await storage().put(key, rendered.bytes, 'application/pdf');

  await withTransaction(async (run) => {
    const [locked] = await run<{ status: string }>(
      'select status from termination where id = $1 for update',
      [terminationId],
    );
    if (!locked || locked.status === 'settled') throw conflict('This deposit is already settled.');

    // The ledger is the record. Every claim and the payout land in it as entries, and they
    // must bring the held balance to zero: arrears and the penalty were missing from it, so
    // a settled lease kept a positive balance and the interest run went on crediting it.
    // Claims come off in the order repairs, arrears, penalty, and stop at what is held; the
    // rest is a debt the statement shows as owed by the tenant, never a negative ledger.
    let remaining = summary.heldCents - alreadyOut;
    const post = async (amount: number, note: string) => {
      const posted = Math.min(amount, Math.max(0, remaining));
      if (posted <= 0) return;
      await run(
        `insert into deposit_ledger (lease_id, entry_type, amount_cents, note)
         values ($1, 'deduction', $2, $3)`,
        [context.lease_id, posted, note],
      );
      remaining -= posted;
    };
    for (const deduction of deductions) await post(Number(deduction.amount_cents), deduction.description);
    if (summary.arrearsCents > 0) await post(summary.arrearsCents, 'Rent arrears');
    if (summary.penaltyCents > 0) await post(summary.penaltyCents, 'Cancellation penalty');
    if (summary.refundCents > 0) {
      await run(
        `insert into deposit_ledger (lease_id, entry_type, amount_cents, note)
         values ($1, 'refund', $2, $3)`,
        [context.lease_id, summary.refundCents, input.refundReference ?? 'Refund on termination'],
      );
    }

    await run(
      `update termination
          set status = 'settled', refund_rule = $2, refund_anchor_on = $3, refund_due_by = $4,
              settled_at = now(), statement_s3_key = $5, statement_sha256 = $6
        where id = $1`,
      [terminationId, rule, anchorIso, isoDate(dueBy), key, rendered.sha256],
    );
    await run("update lease set status = 'terminated' where id = $1", [context.lease_id]);
    await run(
      "update unit set status = 'vacant' where id = (select unit_id from lease where id = $1)",
      [context.lease_id],
    );
    // An open ticket on a lease nobody lives in is noise.
    await run(
      `update ticket set status = 'cancelled'
        where lease_id = $1 and status not in ('closed', 'cancelled')`,
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

  // Settled. A failure from here on is logged, not returned: a 500 now would invite a retry
  // of something that has already happened.
  try {
    const [tenant] = await query<{ sub: string | null; email: string; phone: string }>(
      `select a.cognito_sub as sub, a.email, a.phone
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
