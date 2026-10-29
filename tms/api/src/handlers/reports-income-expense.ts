import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';
import { EXPENSE_CATEGORIES, taxYear, taxYearOf } from '../domain/expense';

const isDate = (value: string | undefined): value is string => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));

interface Row {
  propertyId: string | null;
  property: string;
  invoicedCents: number;
  collectedCents: number;
  expenseCents: Record<string, number>;
  expensesCents: number;
  netCents: number;
}

/**
 * Income against expenses per property for a period, the tax year by default.
 *
 * Two income figures, because they answer different questions. Invoiced is the rent that fell
 * due in the period. Collected is what arrived in it, which is the cash the landlord actually
 * has. Net is collected less expenses. Deposits are not income and are left out: they are the
 * tenant's money until the lease ends.
 */
export const handler = route(async (event) => {
  const landlordId = await landlordIdFor(requireLandlord(event));
  const params = event.queryStringParameters ?? {};
  const fallback = taxYear(taxYearOf(new Date().toISOString().slice(0, 10)));
  const from = params.from ?? fallback.from;
  const to = params.to ?? fallback.to;
  if (!isDate(from) || !isDate(to) || from > to) throw badRequest('Give a from and to date, YYYY-MM-DD, in order.');

  const properties = await query<{ id: string; name: string }>(
    'select id, name from property where landlord_id = $1 order by name',
    [landlordId],
  );
  const invoiced = await query<{ property_id: string; cents: string }>(
    `select u.property_id, sum(i.total_cents)::text as cents
       from invoice i join lease l on l.id = i.lease_id join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where p.landlord_id = $1 and i.status <> 'void' and i.period_start between $2 and $3
      group by u.property_id`,
    [landlordId, from, to],
  );
  const collected = await query<{ property_id: string; cents: string }>(
    `select u.property_id, sum(pay.amount_cents)::text as cents
       from payment pay join lease l on l.id = pay.lease_id join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where p.landlord_id = $1 and pay.received_on between $2 and $3
      group by u.property_id`,
    [landlordId, from, to],
  );
  const expenses = await query<{ property_id: string | null; category: string; cents: string }>(
    `select property_id, category, sum(amount_cents)::text as cents
       from expense where landlord_id = $1 and incurred_on between $2 and $3
      group by property_id, category`,
    [landlordId, from, to],
  );

  const blank = (propertyId: string | null, property: string): Row => ({
    propertyId, property, invoicedCents: 0, collectedCents: 0,
    expenseCents: Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, 0])), expensesCents: 0, netCents: 0,
  });
  const rows = new Map<string | null, Row>(properties.map((p) => [p.id, blank(p.id, p.name)]));
  for (const row of invoiced) rows.get(row.property_id)!.invoicedCents = Number(row.cents);
  for (const row of collected) rows.get(row.property_id)!.collectedCents = Number(row.cents);
  for (const row of expenses) {
    // Rates on the whole portfolio, an accountant's fee: real costs that belong to no one property.
    if (!rows.has(row.property_id)) rows.set(row.property_id, blank(null, 'Not tied to a property'));
    const target = rows.get(row.property_id)!;
    target.expenseCents[row.category] = Number(row.cents);
    target.expensesCents += Number(row.cents);
  }
  const items = [...rows.values()].map((row) => ({ ...row, netCents: row.collectedCents - row.expensesCents }));

  const totals = blank(null, 'Total');
  for (const row of items) {
    totals.invoicedCents += row.invoicedCents;
    totals.collectedCents += row.collectedCents;
    totals.expensesCents += row.expensesCents;
    for (const category of EXPENSE_CATEGORIES) totals.expenseCents[category]! += row.expenseCents[category]!;
  }
  totals.netCents = totals.collectedCents - totals.expensesCents;

  // Month by month, for the trend on the landlord's home screen.
  const monthly = await query<{ month: string; invoiced: string; collected: string }>(
    `with months as (
       select to_char(m, 'YYYY-MM') as month
         from generate_series(date_trunc('month', $2::date), date_trunc('month', $3::date), interval '1 month') m
     )
     select months.month,
            coalesce((select sum(i.total_cents) from invoice i join lease l on l.id = i.lease_id join unit u on u.id = l.unit_id
                        join property p on p.id = u.property_id
                       where p.landlord_id = $1 and i.status <> 'void' and i.period_start between $2 and $3
                         and to_char(i.period_start, 'YYYY-MM') = months.month), 0)::text as invoiced,
            coalesce((select sum(pay.amount_cents) from payment pay join lease l on l.id = pay.lease_id join unit u on u.id = l.unit_id
                        join property p on p.id = u.property_id
                       where p.landlord_id = $1 and pay.received_on between $2 and $3
                         and to_char(pay.received_on, 'YYYY-MM') = months.month), 0)::text as collected
       from months order by months.month`,
    [landlordId, from, to],
  );
  const months = monthly.map((row) => ({
    month: row.month, invoicedCents: Number(row.invoiced), collectedCents: Number(row.collected),
  }));

  return json(200, { from, to, items, totals, months });
});
