import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { conflict, json, parseBody, route } from '../lib/http';
import { updateAccountSchema } from '../domain/landlord';

/** The owner edits the business details. The bank account prints on every invoice, so only the
    owner changes it, and every change is in the activity log with the old number's last digits. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  const input = parseBody(event, updateAccountSchema);

  const sets: string[] = [];
  const values: unknown[] = [landlordId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (input.tradingName !== undefined) set('trading_name', input.tradingName);
  if (input.email !== undefined) set('email', input.email.toLowerCase());
  if (input.phone !== undefined) set('phone', input.phone);
  if (input.registrationNo !== undefined) set('registration_no', input.registrationNo || null);
  if (input.slug !== undefined) set('slug', input.slug);
  if (input.bank) {
    set('bank_name', input.bank.name);
    set('bank_account_holder', input.bank.holder);
    set('bank_account_number', input.bank.accountNumber);
    set('bank_branch_code', input.bank.branchCode);
  }

  if (input.slug !== undefined) {
    const [taken] = await query<{ id: string }>('select id from landlord where slug = $1 and id <> $2', [input.slug, landlordId]);
    if (taken) throw conflict('Another landlord already uses that link. Try a different one.');
  }
  const [before] = await query<{ bank_account_number: string | null }>(
    'select bank_account_number from landlord where id = $1',
    [landlordId],
  );
  await query(`update landlord set ${sets.join(', ')} where id = $1`, values);

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: input.bank ? 'landlord.bank_changed' : 'landlord.updated',
    entity: 'landlord',
    entityId: landlordId,
    detail: {
      fields: Object.keys(input),
      ...(input.bank
        ? { from: before?.bank_account_number?.slice(-4) ?? null, to: input.bank.accountNumber.slice(-4) }
        : {}),
    },
  });
  return json(200, { ok: true });
});
