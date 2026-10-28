import { z } from 'zod';
import { requireApplicationAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, parseBody, route } from '../lib/http';
import { recordConsent } from '../lib/privacy';
import { PRIVACY_VERSION } from '../domain/privacy';

const recordSchema = z.object({
  bureau: z.enum(['transunion', 'experian', 'xds', 'compuscan', 'tpn', 'other']),
  checkedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-28.'),
  score: z.number().int().min(0).max(999).nullable(),
  outcome: z.enum(['clear', 'minor', 'adverse']),
  judgements: z.number().int().min(0).max(99),
  defaults: z.number().int().min(0).max(99),
  notes: z.string().trim().max(1000).nullable(),
  // The bureau's report, uploaded first as a document of kind credit_report.
  reportKey: z.string().max(300).nullable(),
});

const consentSchema = z.object({ consent: z.literal(true), version: z.string().max(20) });

async function consentOf(applicationId: string) {
  const [row] = await query<{ accepted_at: string }>(
    `select accepted_at::text from consent where kind = 'credit_check' and subject_id = $1 order by accepted_at desc limit 1`,
    [applicationId],
  );
  return row ? { acceptedAt: row.accepted_at } : null;
}

/** Whether the applicant agreed, so the landlord knows before running a check. */
export async function hasCreditConsent(applicationId: string) {
  return (await consentOf(applicationId)) !== null;
}

/**
 * GET /applications/{id}/credit-check: the applicant's agreement and the recorded result, for
 * both parties; the applicant has a right to see what is held about them.
 * POST, as the applicant: agree to a credit check for this application.
 * POST, as the landlord: record the result of a check they ran with their own bureau account.
 */
export const handler = route(async (event) => {
  const applicationId = event.pathParameters?.id;
  if (!applicationId) throw badRequest('An application id is required.');
  const access = await requireApplicationAccess(event, applicationId);

  if (event.requestContext.http.method === 'GET') {
    const [check] = await query<{
      bureau: string; checked_on: string; score: number | null; outcome: string; judgements: number; defaults: number;
      notes: string | null; report_key: string | null; recorded_at: string;
    }>(
      `select c.bureau, c.checked_on::text, c.score, c.outcome, c.judgements, c.defaults, c.notes,
              d.s3_key as report_key, c.recorded_at::text
         from credit_check c left join application_document d on d.id = c.document_id
        where c.application_id = $1`,
      [applicationId],
    );
    return json(200, {
      consent: await consentOf(applicationId),
      check: check
        ? {
            bureau: check.bureau, checkedOn: check.checked_on, score: check.score, outcome: check.outcome,
            judgements: check.judgements, defaults: check.defaults, notes: check.notes,
            reportKey: check.report_key, recordedAt: check.recorded_at,
          }
        : null,
    });
  }

  if (access.isApplicant && !access.isLandlord) {
    const { version } = parseBody(event, consentSchema);
    if (version !== PRIVACY_VERSION) throw badRequest('That is not the current privacy notice. Reload and read it again.');
    await withTransaction((run) =>
      recordConsent(run, event, { sub: access.person.sub, kind: 'credit_check', version, subjectId: applicationId }),
    );
    return json(201, { consent: await consentOf(applicationId) });
  }
  if (!access.isLandlord) throw forbidden('You are not a party to this application.');

  const input = parseBody(event, recordSchema);
  // A credit record is checked only with the applicant's agreement (POPIA section 11, and the
  // bureaus' own terms). Without it there is nothing to record.
  if (!(await hasCreditConsent(applicationId))) {
    throw conflict('The applicant has not agreed to a credit check. Ask them to agree on their application first.');
  }
  if (input.checkedOn > new Date().toISOString().slice(0, 10)) throw badRequest('The check date cannot be in the future.');

  let documentId: string | null = null;
  if (input.reportKey) {
    const [document] = await query<{ id: string }>(
      `select id from application_document where application_id = $1 and kind = 'credit_report' and s3_key = $2`,
      [applicationId, input.reportKey],
    );
    if (!document) throw badRequest('Upload the report first, then save the result.');
    documentId = document.id;
  }

  await query(
    `insert into credit_check (application_id, bureau, checked_on, score, outcome, judgements, defaults, notes, document_id, recorded_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (application_id) do update set
       bureau = excluded.bureau, checked_on = excluded.checked_on, score = excluded.score, outcome = excluded.outcome,
       judgements = excluded.judgements, defaults = excluded.defaults, notes = excluded.notes,
       document_id = coalesce(excluded.document_id, credit_check.document_id),
       recorded_by = excluded.recorded_by, recorded_at = now()`,
    [applicationId, input.bureau, input.checkedOn, input.score, input.outcome, input.judgements, input.defaults,
      input.notes || null, documentId, access.person.sub],
  );
  await audit({
    actorSub: access.person.sub, actorRole: 'landlord', action: 'application.credit_checked', entity: 'application',
    entityId: applicationId, detail: { bureau: input.bureau, outcome: input.outcome },
  });
  return json(200, { recorded: true });
});
