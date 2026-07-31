import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { decideRenewalSchema } from '../domain/renewal';
import { zar } from '../domain/money';
import { notify } from '../lib/notify';

export const handler = route(async (event) => {
  const renewalId = event.pathParameters?.id;
  if (!renewalId) throw badRequest('A renewal id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from renewal where id = $1',
    [renewalId],
    'Renewal',
  );
  if (!access.isTenant) throw forbidden('Only the tenant accepts or declines a renewal.');
  const input = parseBody(event, decideRenewalSchema);

  const result = await withTransaction(async (run) => {
    const [renewal] = await run<{
      id: string; lease_id: string; status: string; respond_by: string;
      term_months: number; new_start_date: string; new_end_date: string;
      new_rent_cents: string; escalation_pct: string; deposit_top_up_cents: string;
    }>(
      `select id, lease_id, status, respond_by::text, term_months,
              new_start_date::text, new_end_date::text, new_rent_cents, escalation_pct,
              deposit_top_up_cents
         from renewal where id = $1 for update`,
      [renewalId],
    );
    if (!renewal) throw notFound('Renewal');
    if (renewal.status !== 'offered') throw conflict(`This offer is already ${renewal.status}.`);
    if (new Date(renewal.respond_by) < new Date(new Date().toISOString().slice(0, 10))) {
      throw conflict(`This offer expired on ${renewal.respond_by}. Ask for a new one.`);
    }

    if (input.decision === 'decline') {
      await run(`update renewal set status = 'declined', decided_at = now() where id = $1`, [renewalId]);
      return {
        status: 'declined' as const,
        newLeaseId: null,
        newLeaseRef: null,
        startsOn: null,
        depositTopUpCents: 0,
      };
    }

    const [current] = await run<{ application_id: string; unit_id: string; applicant_id: string }>(
      'select application_id, unit_id, applicant_id from lease where id = $1 for update',
      [renewal.lease_id],
    );
    if (!current) throw notFound('Lease');

    // 'scheduled' exists for exactly this moment: the new lease is real and signed, but the
    // current one is still live until its last day. Two 'active' leases on one unit is
    // blocked by the index, and rightly so.
    const [created] = await run<{ id: string; ref_no: number }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                          monthly_rent_cents, escalation_pct, deposit_cents, status,
                          previous_lease_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled', $9)
       returning id, ref_no`,
      [
        current.application_id, current.unit_id, current.applicant_id,
        renewal.new_start_date, renewal.new_end_date,
        Number(renewal.new_rent_cents), Number(renewal.escalation_pct),
        Number(renewal.new_rent_cents), renewal.lease_id,
      ],
    );

    await run(
      `update renewal set status = 'accepted', decided_at = now(), new_lease_id = $2 where id = $1`,
      [renewalId, created!.id],
    );
    return {
      status: 'accepted' as const,
      newLeaseId: created!.id as string | null,
      newLeaseRef: `LSE-${String(created!.ref_no).padStart(5, '0')}` as string | null,
      startsOn: renewal.new_start_date as string | null,
      depositTopUpCents: Number(renewal.deposit_top_up_cents),
    };
  });

  const [landlord] = await query<{ sub: string | null; email: string; unit: string; tenant: string }>(
    `select ll.cognito_sub as sub, ll.email, p.name || ' ' || u.code as unit,
            a.first_name || ' ' || a.last_name as tenant
       from lease l
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
       join applicant a on a.id = l.applicant_id
      where l.id = $1`,
    [access.leaseId],
  );
  if (landlord?.sub) {
    await notify({
      leaseId: access.leaseId,
      to: { sub: landlord.sub, email: landlord.email },
      kind: result.status === 'accepted' ? 'renewal_accepted' : 'renewal_declined',
      dedupeKey: `renewal_decided:${renewalId}`,
      data: {
        unit: landlord.unit,
        tenant: landlord.tenant,
        startDate: result.startsOn ?? '',
        topUp: result.depositTopUpCents > 0 ? zar(result.depositTopUpCents) : 'nothing',
        note: input.note ?? '',
      },
    });
  }

  await audit({
    actorSub: access.person.sub,
    actorRole: 'tenant',
    action: `renewal.${result.status}`,
    entity: 'renewal',
    entityId: renewalId,
  });

  return json(200, result);
});
