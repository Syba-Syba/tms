import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { leaseParties } from '../lib/lease-parties';
import { putNoticeInForce, takeNoticeEvidence } from '../lib/notice';
import { notify } from '../lib/notify';
import { lockLease } from '../lib/payments';
import { attestNoticeSchema } from '../domain/termination';

/**
 * The landlord stands behind a notice they recorded for the tenant: they attach the tenant's
 * written notice and state that it is genuine. A tenant who gave notice by letter or email and
 * never opened the app otherwise left a notice that could not be confirmed, so the deposit
 * could never be settled. The evidence, the statement and who made it are kept and audited,
 * and the tenant is told and can open the file. It works after the end date too: that is when
 * a tenant who has moved out is least likely to answer.
 */
export const handler = route(async (event) => {
  const terminationId = event.pathParameters?.id;
  if (!terminationId) throw badRequest('A termination id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from termination where id = $1',
    [terminationId],
    'Termination',
  );
  if (!access.isLandlord) throw forbidden('Only the landlord attests to a notice.');
  const input = parseBody(event, attestNoticeSchema);

  const result = await withTransaction(async (run) => {
    await lockLease(run, access.leaseId);
    const [termination] = await run<{
      status: string; effective_on: string; needs: boolean; confirmed: boolean; attested: boolean; lease_status: string;
    }>(
      `select t.status, t.effective_on::text, t.needs_tenant_confirmation as needs,
              t.tenant_confirmed_at is not null as confirmed, t.attested_at is not null as attested,
              (select l.status from lease l where l.id = t.lease_id) as lease_status
         from termination t where t.id = $1 for update of t`,
      [terminationId],
    );
    if (!termination) throw notFound('Termination');
    if (termination.status === 'withdrawn') throw conflict('This notice was withdrawn.');
    if (termination.status === 'settled') throw conflict('The deposit is already settled.');
    if (termination.lease_status !== 'active') throw conflict(`This lease is ${termination.lease_status}.`);
    if (termination.attested) throw conflict('This notice has already been attested.');
    if (!termination.needs) throw conflict('This notice does not need the tenant’s confirmation, so there is nothing to attest.');
    if (termination.confirmed) throw conflict('The tenant has already confirmed this notice.');

    // tenant_confirmed_at is set as well: it is the one test of "in force" everywhere else.
    await run(
      `update termination
          set tenant_confirmed_at = now(), attested_at = now(), attested_by = $2, attestation_statement = $3
        where id = $1`,
      [terminationId, access.person.sub, input.statement],
    );
    const inForce = await putNoticeInForce(run, access.leaseId, terminationId, termination.effective_on);
    await audit(
      {
        actorSub: access.person.sub,
        actorRole: 'landlord',
        action: 'termination.attested',
        entity: 'termination',
        entityId: terminationId,
        detail: {
          statement: input.statement,
          effectiveOn: termination.effective_on,
          landlordRole: access.landlordRole,
          invoicesAdjusted: inForce.invoicesAdjusted,
        },
      },
      run,
    );
    // Last: the checked copy of the file is not undone by a rollback.
    const evidenceKey = await takeNoticeEvidence(run, access.leaseId, input.evidenceKey);
    await run('update termination set evidence_s3_key = $2 where id = $1', [terminationId, evidenceKey]);
    return { effectiveOn: termination.effective_on, evidenceKey, ...inForce };
  });

  const parties = await leaseParties(access.leaseId);
  if (parties) {
    await notify({
      leaseId: access.leaseId,
      to: { sub: parties.tenantSub, email: parties.tenantEmail, phone: parties.tenantPhone },
      kind: 'notice_attested',
      dedupeKey: `notice_attested:${terminationId}`,
      data: { unit: parties.unit, effectiveOn: result.effectiveOn, penaltyLine: '' },
    });
  }

  return json(200, {
    id: terminationId,
    attested: true,
    effectiveOn: result.effectiveOn,
    evidenceKey: result.evidenceKey,
    invoicesAdjusted: result.invoicesAdjusted,
    chargesMoved: result.chargesMoved,
    renewalCancelled: result.renewalCancelled,
  });
});
