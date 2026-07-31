import { assertSigningAs, requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { signLeaseSchema } from '../domain/lease';

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const input = parseBody(event, signLeaseSchema);
  const access = await requireLeaseAccess(event, leaseId);
  // Without this, any signed-in user could post a signature as either party.
  assertSigningAs(access, input.party);
  const person = access.person;

  if (!input.otpVerified) {
    throw badRequest('Verify the one time PIN before signing.');
  }

  const signatureKey = `leases/${leaseId}/signature-${input.party}.png`;
  await storage().put(
    signatureKey,
    Buffer.from(input.signatureBase64.replace(/^data:image\/png;base64,/, ''), 'base64'),
    'image/png',
  );

  const outcome = await withTransaction(async (run) => {
    const [lease] = await run<{ id: string; status: string; unit_id: string; pdf_sha256: string | null }>(
      'select id, status, unit_id, pdf_sha256 from lease where id = $1 for update',
      [leaseId],
    );
    if (!lease) throw notFound('Lease');
    if (lease.status !== 'out_for_signature') {
      throw conflict(`This lease is ${lease.status} and cannot be signed.`);
    }
    // The hash ties the signature to the exact document that was on screen. A lease with no
    // rendered PDF has nothing to tie to, so it cannot be signed at all.
    if (!lease.pdf_sha256) {
      throw conflict('This lease has no rendered document yet. Generate it before signing.');
    }
    if (lease.pdf_sha256 !== input.pdfSha256) {
      throw conflict('The lease changed since you opened it. Reload and read it again.');
    }

    await run(
      `insert into lease_signature
         (lease_id, party, signature_s3_key, otp_verified, ip_address, user_agent, pdf_sha256)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (lease_id, party) do nothing`,
      [
        leaseId,
        input.party,
        signatureKey,
        input.otpVerified,
        event.requestContext.http.sourceIp,
        event.headers['user-agent'] ?? null,
        input.pdfSha256,
      ],
    );

    const rows = await run<{ count: string }>(
      'select count(*)::text as count from lease_signature where lease_id = $1',
      [leaseId],
    );
    const count = Number(rows[0]?.count ?? 0);

    const fullySigned = count === 2;
    if (fullySigned) {
      await run("update lease set status = 'active', activated_at = now() where id = $1", [leaseId]);
      await run("update unit set status = 'occupied' where id = $1", [lease.unit_id]);
    }

    return { fullySigned, signaturesOnFile: count };
  });

  await audit({
    actorSub: person.sub,
    actorRole: input.party,
    action: 'lease.signed',
    entity: 'lease',
    entityId: leaseId,
    detail: { party: input.party, fullySigned: outcome.fullySigned },
  });

  return json(200, {
    status: outcome.fullySigned ? 'active' : 'out_for_signature',
    signaturesOnFile: outcome.signaturesOnFile,
  });
});
