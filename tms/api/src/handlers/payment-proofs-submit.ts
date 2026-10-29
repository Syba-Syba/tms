import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, route } from '../lib/http';
import { sniffImageType } from '../lib/images';
import { notify } from '../lib/notify';
import { storage } from '../lib/storage';
import { zar } from '../domain/money';

const MAX_SLIP_BYTES = 10 * 1024 * 1024;

// The PDF magic number. Four bytes, as file(1) checks it; documents-confirm also wants the dash.
const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).toString('latin1') === '%PDF';

/**
 * Checks an uploaded slip by its bytes and keeps a server copy of exactly what was checked.
 * A presigned PUT binds neither the size nor the type the client declared, and the link stays
 * writable for five minutes, so what someone later reviews could otherwise be anything, and
 * could change after the check. The copy lives under a key no upload link was issued for.
 * A refused upload is removed, so nothing unchecked is left behind in storage.
 * Shared with the expense slip confirm.
 */
export async function keepCheckedSlip(key: string): Promise<{ key: string; contentType: string; size: number }> {
  const size = await storage().sizeOf(key).catch(() => null);
  if (size === null) throw badRequest('The file has not finished uploading. Try sending it again.');
  if (size > MAX_SLIP_BYTES) {
    await storage().remove(key);
    throw badRequest('Files must be under 10 MB.');
  }
  const bytes = await storage().get(key);
  const image = sniffImageType(bytes);
  const ext = image ?? (isPdf(bytes) ? 'pdf' : null);
  if (!ext) {
    await storage().remove(key);
    throw badRequest('That file is not a JPEG, PNG or PDF.');
  }
  const contentType = ext === 'png' ? 'image/png' : ext === 'jpg' ? 'image/jpeg' : 'application/pdf';
  const keptKey = `${key.replace(/\.[a-z]+$/, '')}.kept.${ext}`;
  await storage().put(keptKey, bytes, contentType);
  // No row points at the upload any more, so erasure and the sweep would never find it.
  await storage().remove(key).catch(() => undefined);
  return { key: keptKey, contentType, size };
}

/** Step two: the file is in storage, so the landlord can see it. Tells them it is waiting. */
export const handler = route(async (event) => {
  const proofId = event.pathParameters?.id;
  if (!proofId) throw badRequest('A proof id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from payment_proof where id = $1',
    [proofId],
    'Proof of payment',
  );
  if (!access.isTenant) throw forbidden('Only the tenant sends proof of payment.');

  // The row is locked while the file is checked, so a double tap waits and then finds the
  // slip already sent, instead of checking (and keeping) a second, different upload.
  const proof = await withTransaction(async (run) => {
    const [row] = await run<{
      s3_key: string; status: string; amount_cents: string; paid_on: string; reference: string | null;
    }>(
      'select s3_key, status, amount_cents, paid_on::text, reference from payment_proof where id = $1 for update',
      [proofId],
    );
    if (!row) throw notFound('Proof of payment');
    if (row.status !== 'uploading') throw conflict('That slip was already sent.');

    const kept = await keepCheckedSlip(row.s3_key);
    await run(
      `update payment_proof
          set status = 'pending', submitted_at = now(), s3_key = $2, content_type = $3, size_bytes = $4
        where id = $1`,
      [proofId, kept.key, kept.contentType, kept.size],
    );
    return row;
  });

  const [parties] = await query<{
    landlord_sub: string | null; landlord_email: string; landlord_phone: string; tenant: string; unit: string;
  }>(
    `select ll.cognito_sub as landlord_sub, ll.email as landlord_email, ll.phone as landlord_phone,
            a.first_name || ' ' || a.last_name as tenant, p.name || ' ' || u.code as unit
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where l.id = $1`,
    [access.leaseId],
  );
  if (parties?.landlord_sub) {
    await notify({
      leaseId: access.leaseId,
      to: { sub: parties.landlord_sub, email: parties.landlord_email, phone: parties.landlord_phone },
      kind: 'proof_submitted',
      dedupeKey: `proof_submitted:${proofId}`,
      data: {
        tenant: parties.tenant,
        amount: zar(Number(proof.amount_cents)),
        paidOn: proof.paid_on,
        reference: proof.reference ?? 'none given',
        unit: parties.unit,
      },
    });
  }

  await audit({
    actorSub: access.person.sub,
    actorRole: 'tenant',
    action: 'payment_proof.submitted',
    entity: 'lease',
    entityId: access.leaseId,
    detail: { proofId },
  });
  return json(200, { status: 'pending' });
});
