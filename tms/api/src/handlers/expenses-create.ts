import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { landlordIdFor } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, parseBody, route } from '../lib/http';
import { assertOwnedPlace } from '../lib/landlord-scope';
import { storage } from '../lib/storage';
import { expenseSchema, slipSchema } from '../domain/expense';

const schema = expenseSchema.extend({ slip: slipSchema.optional() });
const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;

/** Records an expense. With a slip, it also hands back a signed link to upload the photo to. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const landlordId = await landlordIdFor(person);
  const input = parseBody(event, schema);
  await assertOwnedPlace(landlordId, input.propertyId, input.unitId);

  const slipKey = input.slip ? `expenses/${landlordId}/${randomUUID()}.${EXTENSION[input.slip.contentType]}` : null;
  const [expense] = await query<{ id: string }>(
    `insert into expense (landlord_id, property_id, unit_id, category, description, amount_cents,
                          incurred_on, slip_s3_key, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      landlordId, input.propertyId ?? null, input.unitId ?? null, input.category, input.description,
      input.amountCents, input.incurredOn, slipKey, person.sub,
    ],
  );
  const uploadUrl = input.slip && slipKey ? await storage().presignPut(slipKey, input.slip.contentType, 300) : null;

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: 'expense.created',
    entity: 'expense',
    entityId: expense!.id,
    detail: { category: input.category, amountCents: input.amountCents, incurredOn: input.incurredOn },
  });
  return json(201, { id: expense!.id, uploadUrl });
});

export type ExpenseInput = z.infer<typeof schema>;
