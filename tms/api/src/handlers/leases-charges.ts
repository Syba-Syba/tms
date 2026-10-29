import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { leaseParties } from '../lib/lease-parties';
import { notify } from '../lib/notify';
import { chargeSchema, invoiceStatus, MONTHS_AHEAD, monthsBetween } from '../domain/charge';
import { isoDate, nextMonthStart, sastToday } from '../domain/dates';
import { billableUntil, RENEWAL_STARTS_SQL } from '../lib/billing';
import { zar } from '../domain/money';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/**
 * Moves an invoice's total by a charge and resets its status from what has been paid. The total
 * moves by the amount rather than being summed from lines: invoices from before lines were
 * kept would otherwise lose their rent.
 */
async function adjustInvoice(run: Run, invoiceId: string, deltaCents: number) {
  const [row] = await run<{ total: string; paid: string }>(
    `update invoice set total_cents = total_cents + $2 where id = $1
     returning total_cents::text as total,
               coalesce((select sum(amount_cents) from payment where invoice_id = $1), 0)::text as paid`,
    [invoiceId, deltaCents],
  );
  const total = Number(row!.total);
  await run('update invoice set status = $2 where id = $1', [invoiceId, invoiceStatus(Number(row!.paid), total)]);
  return total;
}

/**
 * Charges on top of rent: water, electricity, levies, a lost key. POST adds one for a month, on
 * that month's invoice if it is not due yet, else on the next invoice;
 * DELETE /leases/{id}/charges/{chargeId} takes one off, unless it has already been paid.
 */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord adds charges.');
  const chargeId = event.pathParameters?.chargeId;

  if (event.requestContext.http.method === 'DELETE') {
    if (!chargeId) throw badRequest('Which charge?');
    const removed = await withTransaction(async (run) => {
      const [pending] = await run<{ description: string }>(
        'delete from pending_charge where id = $1 and lease_id = $2 returning description',
        [chargeId, leaseId],
      );
      if (pending) return pending.description;
      const [line] = await run<{ invoice_id: string; description: string; amount_cents: string; paid: string; total: string }>(
        `select il.invoice_id, il.description, il.amount_cents::text, i.total_cents::text as total,
                coalesce((select sum(amount_cents) from payment where invoice_id = i.id), 0)::text as paid
           from invoice_line il join invoice i on i.id = il.invoice_id
          where il.id = $1 and i.lease_id = $2 and il.kind in ('utility', 'other') and i.status <> 'void'
          for update of i`,
        [chargeId, leaseId],
      );
      if (!line) throw notFound('Charge');
      if (Number(line.paid) > Number(line.total) - Number(line.amount_cents)) {
        throw conflict('That charge has been paid already. Refund it or credit the next invoice instead.');
      }
      await run('delete from invoice_line where id = $1', [chargeId]);
      await adjustInvoice(run, line.invoice_id, -Number(line.amount_cents));
      return line.description;
    });
    await audit({ actorSub: access.person.sub, actorRole: 'landlord', action: 'charge.removed', entity: 'lease', entityId: leaseId, detail: { description: removed } });
    return json(200, { ok: true });
  }

  const input = parseBody(event, chargeSchema);
  const today = sastToday();
  const result = await withTransaction(async (run) => {
    const [lease] = await run<{ status: string; start_date: string; end_date: string; effective_on: string | null; renewal_starts_on: string | null }>(
      `select l.status, l.start_date::text, l.end_date::text,
              (select t.effective_on::text from termination t where t.lease_id = l.id and t.status <> 'withdrawn' limit 1) as effective_on,
              ${RENEWAL_STARTS_SQL('l')} as renewal_starts_on
         from lease l where l.id = $1 for update`,
      [leaseId],
    );
    if (!lease || !['active', 'terminated'].includes(lease.status)) throw conflict('Charges go on a running lease.');
    if (input.period < lease.start_date.slice(0, 7)) throw badRequest('That month is before the lease started.');
    if (monthsBetween(today.slice(0, 7), input.period) > MONTHS_AHEAD) {
      throw badRequest(`Add charges at most ${MONTHS_AHEAD} months ahead.`);
    }

    // A charge only goes on an invoice that is not due yet. Put on one already due, it would be
    // overdue the moment it was added, and the arrears steps would chase water added this
    // morning as weeks late. Late charges ride the next invoice instead, named for their month.
    const openInvoice = async (month: string) =>
      (await run<{ id: string; due_on: string }>(
        `select id, due_on::text from invoice where lease_id = $1 and period_start = $2 and status <> 'void' for update`,
        [leaseId, `${month}-01`],
      ))[0] ?? null;
    const currentMonth = today.slice(0, 7);
    let target = input.period;
    let invoice = await openInvoice(target);
    if ((invoice && invoice.due_on < today) || (!invoice && target < currentMonth)) {
      const current = await openInvoice(currentMonth);
      target = current && current.due_on >= today ? currentMonth : nextMonthStart(`${currentMonth}-01`).slice(0, 7);
      invoice = await openInvoice(target);
    }
    // A lease that is ending has no invoice after its last month, and the run will never make
    // one. A charge headed past that month used to wait in pending_charge for ever, billed to
    // nobody and missing from the deposit settlement. It goes on the last invoice instead.
    // Notice ends billing on its effective day (the run stops there too); a signed renewal hands
    // over to the new lease the day before it starts.
    const lastDay = lease.effective_on
      ?? (lease.renewal_starts_on
        ? isoDate(billableUntil({ endDate: lease.end_date, terminationEffectiveOn: null, renewalStartsOn: lease.renewal_starts_on }))
        : null);
    const lastMonth = lastDay ? lastDay.slice(0, 7) : null;
    if (!invoice && lastMonth && target > lastMonth) {
      const [last] = await run<{ id: string; due_on: string; period_start: string }>(
        `select id, due_on::text, period_start::text from invoice
          where lease_id = $1 and status <> 'void' order by period_start desc limit 1 for update`,
        [leaseId],
      );
      if (!last) throw conflict('This lease has no invoice left to add a charge to.');
      target = last.period_start.slice(0, 7);
      invoice = last;
    }
    const description = target === input.period ? input.description : `${input.description} (${monthLabel(input.period)})`;

    if (invoice) {
      const [line] = await run<{ id: string }>(
        `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, $2, $3, $4) returning id`,
        [invoice.id, input.kind, description, input.amountCents],
      );
      const total = await adjustInvoice(run, invoice.id, input.amountCents);
      return { id: line!.id, billed: true, totalCents: total, onMonth: target, description };
    }
    const [pending] = await run<{ id: string }>(
      `insert into pending_charge (lease_id, period_start, kind, description, amount_cents, added_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [leaseId, `${target}-01`, input.kind, description, input.amountCents, access.person.sub],
    );
    return { id: pending!.id, billed: false, totalCents: null, onMonth: target, description };
  });

  // A charge on an invoice already out is news to the tenant; one waiting for next month's
  // invoice arrives with it.
  if (result.billed) {
    const parties = await leaseParties(leaseId);
    if (parties) {
      await notify({
        leaseId,
        to: { sub: parties.tenantSub, email: parties.tenantEmail, phone: parties.tenantPhone },
        kind: 'charge_added',
        dedupeKey: `charge_added:${result.id}`,
        data: {
          description: result.description, amount: zar(input.amountCents), period: monthLabel(result.onMonth),
          total: zar(result.totalCents!), unit: parties.unit, reference: parties.ref,
        },
      });
    }
  }
  await audit({
    actorSub: access.person.sub, actorRole: 'landlord', action: 'charge.added', entity: 'lease', entityId: leaseId,
    detail: { period: input.period, kind: input.kind, description: input.description, amountCents: input.amountCents },
  });
  return json(201, result);
});
