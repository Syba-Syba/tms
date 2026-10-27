import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, route } from '../lib/http';
import { notify } from '../lib/notify';
import { storage } from '../lib/storage';
import { zar } from '../domain/money';

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

  const [proof] = await query<{
    s3_key: string; status: string; amount_cents: string; paid_on: string; reference: string | null;
  }>(
    'select s3_key, status, amount_cents, paid_on::text, reference from payment_proof where id = $1',
    [proofId],
  );
  if (!proof) throw notFound('Proof of payment');
  if (proof.status !== 'uploading') throw conflict('That slip was already sent.');

  const size = await storage().sizeOf(proof.s3_key).catch(() => null);
  if (size === null) throw badRequest('The file has not finished uploading. Try sending it again.');

  // Guarded on status so a double tap cannot notify the landlord twice.
  const updated = await query(
    `update payment_proof set status = 'pending', submitted_at = now()
      where id = $1 and status = 'uploading' returning id`,
    [proofId],
  );
  if (updated.length === 0) throw conflict('That slip was already sent.');

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
