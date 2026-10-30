import { landlordIdFor } from '../lib/access';
import { storage } from '../lib/storage';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';
import { assertOwnedPlace } from '../lib/landlord-scope';
import { expenseSchema } from '../domain/expense';

/** PUT edits an expense; DELETE removes it. Both only reach the caller's own rows. */
export const handler = route(async (event) => {
  const expenseId = event.pathParameters?.id;
  if (!expenseId) throw badRequest('An expense id is required.');
  const person = requireLandlord(event);
  const landlordId = await landlordIdFor(person);
  const method = event.requestContext.http.method;

  if (method === 'DELETE') {
    const removed = await query<{ amount_cents: string; category: string; slip_s3_key: string | null }>(
      'delete from expense where id = $1 and landlord_id = $2 returning amount_cents, category, slip_s3_key',
      [expenseId, landlordId],
    );
    if (removed.length === 0) throw notFound('Expense');
    const { slip_s3_key: slip, ...detail } = removed[0]!;
    // The slip (a supplier's invoice, often with names on it) goes with the expense; no row
    // would find it afterwards. Both the checked copy and the raw upload it came from.
    if (slip) {
      await storage().remove(slip).catch(() => undefined);
      await storage().remove(slip.replace(/\.kept\.([a-z]+)$/, '.$1')).catch(() => undefined);
    }
    await audit({
      actorSub: person.sub, actorRole: 'landlord', action: 'expense.deleted', entity: 'expense',
      entityId: expenseId, detail,
    });
    return json(200, { deleted: true });
  }

  const input = parseBody(event, expenseSchema);
  const own = await query('select 1 from expense where id = $1 and landlord_id = $2', [expenseId, landlordId]);
  if (own.length === 0) throw notFound('Expense');
  await assertOwnedPlace(landlordId, input.propertyId, input.unitId);
  const updated = await query(
    `update expense set property_id = $3, unit_id = $4, category = $5, description = $6,
                        amount_cents = $7, incurred_on = $8
      where id = $1 and landlord_id = $2 returning id`,
    [
      expenseId, landlordId, input.propertyId ?? null, input.unitId ?? null, input.category,
      input.description, input.amountCents, input.incurredOn,
    ],
  );
  if (updated.length === 0) throw notFound('Expense');
  await audit({
    actorSub: person.sub, actorRole: 'landlord', action: 'expense.updated', entity: 'expense',
    entityId: expenseId, detail: input,
  });
  return json(200, { id: expenseId });
});
