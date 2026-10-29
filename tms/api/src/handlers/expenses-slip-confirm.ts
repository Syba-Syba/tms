import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { badRequest, json, notFound, route } from '../lib/http';
import { storage } from '../lib/storage';
import { keepCheckedSlip } from './payment-proofs-submit';

/**
 * The client calls this after the slip's PUT succeeds. Creating the expense only issued an
 * upload link, which binds neither size nor type and stays writable for five minutes, so the
 * slip is checked by its bytes here and the expense points at a kept copy of what was checked.
 * A refused slip is removed and detached; the expense itself stands.
 */
export const handler = route(async (event) => {
  const expenseId = event.pathParameters?.id;
  if (!expenseId) throw badRequest('An expense id is required.');
  const person = requireLandlord(event);
  const landlordId = await landlordIdFor(person);

  const result = await withTransaction(async (run) => {
    const [expense] = await run<{ slip_s3_key: string | null }>(
      'select slip_s3_key from expense where id = $1 and landlord_id = $2 for update',
      [expenseId, landlordId],
    );
    if (!expense) throw notFound('Expense');
    if (!expense.slip_s3_key) throw badRequest('This expense has no slip to confirm.');
    // Confirming twice is a retry: the kept copy already stands.
    if (/\.kept\.[a-z]+$/.test(expense.slip_s3_key)) return { key: expense.slip_s3_key, refused: null };

    const landed = await storage().sizeOf(expense.slip_s3_key).catch(() => null);
    if (landed === null) throw badRequest('That upload has not landed yet. Retry the upload, then confirm.');

    try {
      const kept = await keepCheckedSlip(expense.slip_s3_key);
      await run('update expense set slip_s3_key = $2 where id = $1', [expenseId, kept.key]);
      return { key: kept.key, refused: null };
    } catch (error) {
      // The check removed the refused upload; detach it so the expense does not point at
      // nothing. Returned, not thrown, so this update commits.
      await run('update expense set slip_s3_key = null where id = $1', [expenseId]);
      return { key: null, refused: error };
    }
  });

  if (result.refused) throw result.refused;
  return json(200, { confirmed: true, key: result.key });
});
