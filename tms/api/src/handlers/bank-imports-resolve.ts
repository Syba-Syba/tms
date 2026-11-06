import { z } from 'zod';
import { landlordIdFor } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { importDetail } from '../lib/bank';
import { query, withTransaction } from '../lib/db';
import { ApiError, badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { allocatePayment, assertDepositOpen, balanceLineFor, notifyPaymentReceived, type Allocation } from '../lib/payments';

const schema = z.object({
  lines: z
    .array(
      z.union([
        z.object({ lineId: z.guid(), leaseId: z.guid() }),
        z.object({ lineId: z.guid(), ignore: z.literal(true) }),
      ]),
    )
    .min(1)
    .max(500),
});

interface Result {
  lineId: string;
  ok: boolean;
  error?: string;
}

/**
 * Records the confirmed lines as payments, or sets them aside. Each line commits on its own,
 * so one that no longer fits (the tenant paid in cash meanwhile) does not hold back the rest.
 *
 * A slip the tenant already sent for the same amount is accepted by the same step, so the
 * landlord never has to tick the same payment off twice.
 */
export const handler = route(async (event) => {
  const importId = event.pathParameters?.id;
  if (!importId) throw badRequest('An import id is required.');
  const person = requireLandlord(event);
  const landlordId = await landlordIdFor(person);
  const input = parseBody(event, schema);
  const owned = await query('select 1 from bank_import where id = $1 and landlord_id = $2', [importId, landlordId]);
  if (owned.length === 0) throw notFound('Bank import');

  const results: Result[] = [];
  const toNotify: Array<{ leaseId: string; amountCents: number; postedOn: string; line: string }> = [];

  for (const item of input.lines) {
    try {
      const outcome = await withTransaction(async (run) => {
        // The lease first, before the line: accepting a slip takes the same lease lock and then
        // looks for a matched line, so a slip and its line confirmed at the same moment run one
        // after the other and the second links to the first instead of recording it again.
        const [lease] = 'ignore' in item
          ? []
          : await run<{ id: string }>(
              `select l.id from lease l
                 join unit u on u.id = l.unit_id
                 join property p on p.id = u.property_id
                where l.id = $1 and p.landlord_id = $2
                  and l.status in ('out_for_signature', 'active', 'terminated')
                  for update of l`,
              [item.leaseId, landlordId],
            );
        const [line] = await run<{ id: string; posted_on: string; amount_cents: string; description: string; status: string }>(
          `select id, posted_on::text, amount_cents, description, status
             from bank_line where id = $1 and import_id = $2 and landlord_id = $3 for update`,
          [item.lineId, importId, landlordId],
        );
        if (!line) throw notFound('Bank line');
        if (line.status !== 'unmatched') throw conflict('That line was already dealt with.');

        if ('ignore' in item) {
          await run(
            `update bank_line set status = 'ignored', resolved_by = $2, resolved_at = now() where id = $1`,
            [line.id, person.sub],
          );
          return null;
        }

        if (!lease) throw notFound('Lease');

        const amountCents = Number(line.amount_cents);
        // The slip for this money may already be accepted, and its payment recorded. Recording
        // the bank line as well counted the same rent twice and spilled it onto next month.
        // Link the line to that payment instead.
        const [recorded] = await run<{ id: string }>(
          `select pp.id from payment_proof pp
            where pp.lease_id = $1 and pp.status = 'accepted' and pp.target = 'invoice' and pp.amount_cents = $2
              and pp.paid_on between $3::date - 14 and $3::date + 3
              and exists (select 1 from payment p where p.proof_id = pp.id)
              and not exists (select 1 from payment p where p.proof_id = pp.id and p.bank_line_id is not null)
            order by abs(pp.paid_on - $3::date) limit 1
            for update`,
          [lease.id, amountCents, line.posted_on],
        );
        if (recorded) {
          await run('update payment set bank_line_id = $2 where proof_id = $1', [recorded.id, line.id]);
          await run(
            `update bank_line set status = 'matched', lease_id = $2, resolved_by = $3, resolved_at = now() where id = $1`,
            [line.id, lease.id, person.sub],
          );
          // The tenant was told when the slip was accepted; nothing new to say.
          return null;
        }
        // The same for a deposit slip already accepted: the deposit is on the ledger, and this
        // line is that transfer arriving. Recorded again it went onto the rent, so one payment
        // counted as both deposit and rent.
        const [deposited] = await run<{ id: string }>(
          `select pp.id from payment_proof pp
            where pp.lease_id = $1 and pp.status = 'accepted' and pp.target = 'deposit'
              and pp.paid_on between $3::date - 14 and $3::date + 3
              and $2::bigint = coalesce((select sum(d.amount_cents) from deposit_ledger d where d.proof_id = pp.id),
                                        pp.amount_cents)
              and not exists (select 1 from bank_line b where b.proof_id = pp.id)
              and not exists (select 1 from deposit_ledger d where d.proof_id = pp.id and d.bank_line_id is not null)
            order by abs(pp.paid_on - $3::date) limit 1
            for update`,
          [lease.id, amountCents, line.posted_on],
        );
        if (deposited) {
          await run('update deposit_ledger set bank_line_id = $2 where proof_id = $1', [deposited.id, line.id]);
          await run(
            `update bank_line set status = 'matched', lease_id = $2, proof_id = $4, resolved_by = $3, resolved_at = now()
              where id = $1`,
            [line.id, lease.id, person.sub, deposited.id],
          );
          return null;
        }
        const [proof] = await run<{ id: string; target: string; invoice_id: string | null }>(
          `select id, target, invoice_id from payment_proof
            where lease_id = $1 and status = 'pending' and amount_cents = $2
            order by submitted_at limit 1 for update`,
          [lease.id, amountCents],
        );

        let allocations: Allocation[] = [];
        let balanceLine: string;
        if (proof?.target === 'deposit') {
          await assertDepositOpen(run, lease.id);
          await run(
            `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note, proof_id, bank_line_id)
             values ($1, 'received', $2, $3, $4, $5, $6)`,
            [lease.id, amountCents, line.posted_on, line.description.slice(0, 60), proof.id, line.id],
          );
          balanceLine = 'It has been added to your deposit.';
        } else {
          allocations = await allocatePayment(run, {
            leaseId: lease.id,
            amountCents,
            invoiceId: proof?.invoice_id ?? null,
            method: 'eft',
            reference: line.description,
            receivedOn: line.posted_on,
            recordedBy: person.sub,
            proofId: proof?.id ?? null,
            bankLineId: line.id,
          });
          balanceLine = balanceLineFor(allocations);
        }
        if (proof) {
          await run(
            `update payment_proof set status = 'accepted', reviewed_by = $2, reviewed_at = now() where id = $1`,
            [proof.id, person.sub],
          );
        }
        await run(
          `update bank_line set status = 'matched', lease_id = $2, resolved_by = $3, resolved_at = now() where id = $1`,
          [line.id, lease.id, person.sub],
        );
        return { leaseId: lease.id, amountCents, postedOn: line.posted_on, line: balanceLine };
      });
      if (outcome) toNotify.push(outcome);
      results.push({ lineId: item.lineId, ok: true });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      results.push({ lineId: item.lineId, ok: false, error: error.message });
    }
  }

  for (const paid of toNotify) {
    await notifyPaymentReceived(paid.leaseId, paid.amountCents, paid.postedOn, paid.line);
  }

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: 'bank_import.resolved',
    entity: 'bank_import',
    entityId: importId,
    detail: { matched: toNotify.length, results },
  });

  const detail = await importDetail(importId, landlordId);
  return json(200, { results, import: detail });
});
