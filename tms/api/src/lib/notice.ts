import { movePendingChargesPast, trimInvoicesAfter } from './billing';
import { badRequest, conflict } from './http';
import { keepCheckedSlip } from '../handlers/payment-proofs-submit';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** The renewal lease waiting to take over from this one, locked, and whether both have signed it. */
export async function scheduledRenewal(run: Run, leaseId: string) {
  const [renewed] = await run<{ id: string; start_date: string; signed: boolean }>(
    `select l.id, l.start_date::text,
            (select count(*) from lease_signature s where s.lease_id = l.id) = 2 as signed
       from lease l where l.previous_lease_id = $1 and l.status = 'scheduled' for update`,
    [leaseId],
  );
  return renewed ?? null;
}

export const signedRenewalRefusal = (startDate: string) =>
  conflict(
    `A renewal of this lease has been signed and starts on ${startDate}, so notice ` +
      'cannot be served on it. Once the new lease starts, notice is given on that one.',
  );

/**
 * What a notice changes once it binds: offers to renew lapse, an accepted but unsigned renewal
 * is cancelled, invoices past the end date are trimmed and charges for later months move onto
 * the last invoice. A notice the landlord recorded for the tenant does none of this until the
 * tenant confirms it or the landlord attests to it: before then it is one party's word, and it
 * used to stop the rent on that word alone. Runs inside the caller's transaction, which holds
 * the lease lock.
 */
export async function putNoticeInForce(run: Run, leaseId: string, terminationId: string, effectiveOn: string) {
  const renewed = await scheduledRenewal(run, leaseId);
  if (renewed?.signed) throw signedRenewalRefusal(renewed.start_date);

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
    terminationId,
    lapsed.map((row) => row.id),
    renewed?.id ?? null,
  ]);

  // Next month's rent may already have been invoiced in full on the 25th.
  const invoicesAdjusted = await trimInvoicesAfter(run, leaseId, effectiveOn);
  // A charge already added for a month after the lease now ends would never be billed: the
  // invoice run stops at the last month. It goes on the last invoice instead.
  const chargesMoved = await movePendingChargesPast(run, leaseId, effectiveOn);
  return { invoicesAdjusted, chargesMoved, renewalCancelled: renewed?.id ?? null };
}

/**
 * Checks the file a landlord offers as the tenant's written notice and returns the key to keep
 * on the notice. /files/view serves any key a notice holds to both parties, so it must be a
 * file that belongs to this lease: an upload made for it through /notice-evidence/presign, or,
 * as for deduction evidence, a photo already on the lease. An upload is checked by its bytes
 * and a server copy kept, as for payment slips. Call last in the transaction: the copy is
 * not undone by a rollback.
 */
export async function takeNoticeEvidence(run: Run, leaseId: string, key: string): Promise<string> {
  const [upload] = await run<{ s3_key: string }>(
    'select s3_key from notice_evidence where s3_key = $1 and lease_id = $2 for update',
    [key, leaseId],
  );
  if (upload) {
    const kept = await keepCheckedSlip(key);
    await run('delete from notice_evidence where s3_key = $1', [key]);
    return kept.key;
  }
  const [photo] = await run<{ ok: boolean }>(
    `select exists (
       select 1 from inspection_photo p
         join inspection_finding f on f.id = p.finding_id
         join inspection i on i.id = f.inspection_id
        where i.lease_id = $1 and p.s3_key = $2 and p.uploaded
       union all
       select 1 from ticket_photo p
         join ticket tk on tk.id = p.ticket_id
        where tk.lease_id = $1 and p.s3_key = $2 and p.uploaded
     ) as ok`,
    [leaseId, key],
  );
  if (!photo?.ok) {
    throw badRequest('The written notice must be a file uploaded for this lease.', {
      evidenceKey: 'Not a file uploaded for this lease.',
    });
  }
  return key;
}
