import { query } from '../lib/db';
import { jobLogger } from '../lib/logger';
import { storage } from '../lib/storage';
import { DECLINED_RETENTION_MONTHS } from '../domain/privacy';

const log = jobLogger('privacy-sweep');

/**
 * Runs daily. An applicant who was declined, or withdrew, handed over an ID copy, payslips and
 * bank statements for a decision that is long made. Twelve months on, those files go. The
 * application row stays, so the landlord's history still shows the decision and its reason.
 */
export const handler = async () => {
  const stale = await query<{ id: string; s3_key: string }>(
    `select d.id, d.s3_key
       from application_document d
       join application a on a.id = d.application_id
      where a.status in ('declined', 'withdrawn')
        and coalesce(a.decided_at, a.updated_at, a.submitted_at) < now() - make_interval(months => $1)
        and not exists (select 1 from lease l where l.application_id = a.id)
      limit 500`,
    [DECLINED_RETENTION_MONTHS],
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
      where a.id = c.application_id and a.status in ('declined', 'withdrawn')
        and coalesce(a.decided_at, a.updated_at, a.submitted_at) < now() - make_interval(months => $1)
        and not exists (select 1 from lease l where l.application_id = a.id)
      returning c.id`,
    [DECLINED_RETENTION_MONTHS],
  );
  log.info('Privacy sweep complete.', { found: stale.length, removed, creditChecks: checks.length });
  return { found: stale.length, removed };
};
