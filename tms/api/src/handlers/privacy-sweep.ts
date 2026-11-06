import { query } from '../lib/db';
import { jobLogger } from '../lib/logger';
import { storage } from '../lib/storage';
import { sastToday } from '../domain/dates';
import { DECLINED_RETENTION_MONTHS, LEASE_RETENTION_YEARS, retainedUntil } from '../domain/privacy';

const log = jobLogger('privacy-sweep');

/**
 * Runs daily. An applicant who was declined, or withdrew, handed over an ID copy, payslips and
 * bank statements for a decision that is long made. Twelve months on, those files go. The
 * application row stays, so the landlord's history still shows the decision and its reason.
 *
 * The same goes for an application nobody ever decided (no change in twelve months), and one
 * approved that never got a lease (twelve months after the approval). Those kept their files
 * forever, because only declined and withdrawn ones were swept.
 *
 * And for a tenant's application once their tenancy with that landlord has ended and the
 * five-year period after it has run out.
 */
const FINISHED_WITHOUT_TENANCY = `
  ((a.status in ('declined', 'withdrawn')
     and coalesce(a.decided_at, a.updated_at, a.submitted_at) < now() - make_interval(months => $1))
   or (a.status in ('submitted', 'screening')
     and a.updated_at < now() - make_interval(months => $1))
   or (a.status = 'approved'
     and coalesce(a.decided_at, a.updated_at) < now() - make_interval(months => $1)))
  -- A cancelled lease (withdrawn before it took effect) is no tenancy, as in retainedUntil. It
  -- kept the paperwork forever. A draft still counts: the landlord may yet finish it.
  and not exists (select 1 from lease l where l.application_id = a.id and l.status <> 'cancelled')`;

/**
 * Applications that did become a tenancy, now over: none of their leases is live. Their
 * paperwork goes once the five-year rule (domain/privacy.ts) has run out for every lease the
 * person had with that landlord.
 */
const TENANCY_OVER = `
  select a.id, a.applicant_id, pr.landlord_id
    from application a join unit u on u.id = a.unit_id join property pr on pr.id = u.property_id
   where exists (select 1 from lease l where l.application_id = a.id and l.status not in ('draft', 'cancelled'))
     and not exists (select 1 from lease l where l.application_id = a.id and l.status in ('draft', 'out_for_signature', 'scheduled', 'active'))
     and (exists (select 1 from application_document d where d.application_id = a.id)
          or exists (select 1 from credit_check c where c.application_id = a.id))
     -- Only those whose five years have run out for every lease with that landlord. Without
     -- this the limit filled up with tenancies still inside the period, the same ones every
     -- night, and the expired ones behind them were never reached. retainedUntil re-checks.
     and not exists (
       select 1 from lease l
         join unit lu on lu.id = l.unit_id join property lp on lp.id = lu.property_id
         left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
        where l.applicant_id = a.applicant_id and lp.landlord_id = pr.landlord_id
          and l.status not in ('draft', 'cancelled')
          and (l.status <> 'terminated'
               or coalesce(t.effective_on, l.end_date) > current_date - make_interval(years => $1)))
   order by a.updated_at
   limit 200`;

/** Exported for a test: the batch must hold only tenancies whose period has run out. */
export const tenancyCandidates = () =>
  query<{ id: string; applicant_id: string; landlord_id: string }>(TENANCY_OVER, [LEASE_RETENTION_YEARS]);

async function tenanciesPastRetention(): Promise<string[]> {
  const candidates = await tenancyCandidates();
  const today = sastToday();
  const expired: string[] = [];
  for (const candidate of candidates) {
    const leases = await query<{ status: string; end_date: string; effective_on: string | null }>(
      `select l.status, l.end_date::text, t.effective_on::text
         from lease l
         left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
         join unit u on u.id = l.unit_id join property pr on pr.id = u.property_id
        where l.applicant_id = $1 and pr.landlord_id = $2`,
      [candidate.applicant_id, candidate.landlord_id],
    );
    const until = retainedUntil(leases.map((l) => ({ status: l.status, endDate: l.end_date, terminationEffectiveOn: l.effective_on })));
    if (until && until <= today) expired.push(candidate.id);
  }
  return expired;
}

export const handler = async () => {
  const ended = await tenanciesPastRetention();
  const stale = await query<{ id: string; s3_key: string }>(
    `select d.id, d.s3_key
       from application_document d
       join application a on a.id = d.application_id
      where (${FINISHED_WITHOUT_TENANCY}) or a.id = any($2)
      limit 500`,
    [DECLINED_RETENTION_MONTHS, ended],
  );
  let removed = 0;
  for (const document of stale) {
    try {
      await storage().remove(document.s3_key);
      await query('delete from application_document where id = $1', [document.id]);
      removed += 1;
    } catch (error) {
      log.error('Could not purge an application document.', { documentId: document.id, error });
    }
  }
  // The recorded credit result goes with the report, on the same clock.
  const checks = await query<{ id: string }>(
    `delete from credit_check c using application a
      where a.id = c.application_id and ((${FINISHED_WITHOUT_TENANCY}) or a.id = any($2))
      returning c.id`,
    [DECLINED_RETENTION_MONTHS, ended],
  );
  // Failed sign-ins carry an email and an IP address, often of someone with no account here.
  // They matter for spotting an attack in progress, not for ever.
  const failedLogins = await query<{ id: string }>(
    `delete from audit_log where action = 'auth.login_failed' and at < now() - interval '90 days' returning id`,
  );
  // The last message to an erased person ("your information has been erased") has to carry
  // their address to be sent. Once it has gone out, and their identity is erased, it goes too.
  // Erased is read from the erasure's own record: a Cognito user never has a local_credential
  // row, so its absence deleted the replies of every live user in aws mode.
  await query(
    `delete from notification
      where kind = 'privacy_request' and status in ('sent', 'failed', 'skipped')
        and created_at < now() - interval '30 days'
        and not exists (select 1 from local_credential c where c.sub = notification.recipient_sub)
        and exists (select 1 from audit_log g
                     where g.action = 'privacy.erased' and g.detail->>'personSub' = notification.recipient_sub
                       and g.detail->>'identityErased' = 'true')`,
  );
  log.info('Privacy sweep complete.', { found: stale.length, removed, creditChecks: checks.length, failedLogins: failedLogins.length });
  return { found: stale.length, removed };
};
