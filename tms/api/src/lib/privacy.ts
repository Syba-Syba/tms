import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { audit } from './audit';
import { query, withTransaction } from './db';
import { logger } from './logger';
import { removeSignIn } from './cognito';
import { storage } from './storage';
import { sastToday } from '../domain/dates';
import { erasureBlock, type LeaseForRetention } from '../domain/privacy';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

const escapeRegex = (text: string) => text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
/**
 * One regex for whole-word matches of any of these strings. A plain replace() turned 'Ann'
 * inside 'Annandale Court' into 'the tenantandale Court'. With nothing to match, it matches
 * nothing (an empty alternation would match everywhere).
 */
const wholeWords = (words: string[]) => {
  const usable = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 3))].sort((a, b) => b.length - a.length);
  return usable.length ? `(?<![[:alnum:]])(${usable.map(escapeRegex).join('|')})(?![[:alnum:]])` : '(?!)x';
};

/**
 * Takes their names and emails out of activity-log details. It works on the parsed JSON's
 * string values: a regex over detail::text could hit a JSON token (a name such as 'Null'
 * lower-cased) and break the cast, and missed names stored with quotes or backslashes escaped.
 */
async function scrubAuditDetails(
  run: Run,
  rows: { id: string; detail: unknown; own: boolean }[],
  names: string[],
  emails: string[],
): Promise<void> {
  const usable = [...new Set(names.map((w) => w.trim()).filter((w) => w.length >= 3))].sort((a, b) => b.length - a.length);
  const namesRe = usable.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${usable.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
  const usableEmails = [...new Set(emails.filter(Boolean))];
  const emailsRe = usableEmails.length ? new RegExp(`(${usableEmails.map(escapeRegex).join('|')})`, 'giu') : null;
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = emailsRe ? value.replace(emailsRe, '[email removed]') : value;
      if (namesRe) out = out.replace(namesRe, 'the tenant');
      return out;
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  for (const row of rows) {
    if (row.detail === null || row.detail === undefined) continue;
    let next = clean(row.detail);
    // The IP address on their own rows (and sign-ins for their email) is theirs; on a
    // landlord's row about them it is the landlord's.
    if (row.own && next && typeof next === 'object' && !Array.isArray(next)) {
      const { address: _address, ...rest } = next as Record<string, unknown>;
      next = rest;
    }
    if (JSON.stringify(next) !== JSON.stringify(row.detail)) {
      await run('update audit_log set detail = $2::jsonb where id = $1', [row.id, JSON.stringify(next)]);
    }
  }
}

/** Records what someone agreed to, with enough context to prove it later. */
export async function recordConsent(
  run: Run,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  input: { sub: string; kind: 'privacy_notice' | 'application_screening' | 'terms_of_service' | 'credit_check'; version: string; subjectId?: string },
): Promise<void> {
  await run(
    `insert into consent (person_sub, kind, version, ip_address, user_agent, subject_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      input.sub,
      input.kind,
      input.version,
      event.requestContext.http?.sourceIp ?? null,
      (event.requestContext.http?.userAgent ?? '').slice(0, 300) || null,
      input.subjectId ?? null,
    ],
  );
}

/** Every lease a person has been the tenant on (with one landlord, or any), as the retention rule reads them. */
export async function leasesOf(sub: string, landlordId: string | null = null): Promise<LeaseForRetention[]> {
  const rows = await query<{ status: string; end_date: string; effective_on: string | null }>(
    `select l.status, l.end_date::text, t.effective_on::text
       from lease l
       join applicant a on a.id = l.applicant_id
       left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where a.cognito_sub = $1 and ($2::uuid is null or p.landlord_id = $2)`,
    [sub, landlordId],
  );
  return rows.map((row) => ({ status: row.status, endDate: row.end_date, terminationEffectiveOn: row.effective_on }));
}

export async function erasureBlockFor(sub: string, landlordId: string | null = null): Promise<string | null> {
  return erasureBlock(await leasesOf(sub, landlordId), sastToday());
}

/**
 * Erases what one landlord holds about a person, and the person's identity once no landlord
 * holds anything more about them.
 *
 * With `landlordId`, that landlord's records only, as the responsible party for them: uploaded
 * files and generated documents are deleted, free text the person wrote is blanked, payment
 * references and bank lines lose their name, and their name, email and phone are scrubbed from
 * that landlord's messages. The landlord's applications and leases then move onto an anonymous
 * stand-in record, so every screen of that landlord shows "Erased person" while rent, deposits
 * and leases still add up. Other landlords' records are not touched.
 *
 * Then, and also without `landlordId`, the identity goes once no application is left on the
 * person's own record: the applicant row, the sign-in, messages to them, the IP address and
 * device on their consents, and their email, name and IP addresses in the activity log. Someone
 * who still has records with another landlord (even one they never asked) keeps their account.
 *
 * Callers check the retention rule first. This does not, so a test can exercise it directly.
 */
export async function erasePerson(
  sub: string,
  actor: { sub: string; role: string },
  scope: { landlordId?: string; replayOf?: string } = {},
): Promise<{ files: number; identityErased: boolean }> {
  const landlordId = scope.landlordId ?? null;
  const { keys, identityErased } = await withTransaction(async (run) => {
    const [applicant] = await run<{ id: string; first_name: string; last_name: string; email: string; phone: string }>(
      'select id, first_name, last_name, email, phone from applicant where cognito_sub = $1 for update',
      [sub],
    );
    const [credential] = await run<{ email: string; name: string }>(
      'select email, name from local_credential where sub = $1',
      [sub],
    );
    const files: string[] = [];
    const collect = async (sql: string, params: unknown[]) => {
      const rows = await run<{ key: string | null }>(sql, params);
      for (const { key } of rows) {
        if (!key || key.startsWith('erased/')) continue;
        files.push(key);
        // A checked copy was made from a raw upload; the raw one is deleted too.
        const raw = key.replace(/\.kept\.([a-z]+)$/, '.$1');
        if (raw !== key) files.push(raw);
      }
    };

    if (applicant && landlordId) {
      const applications = (
        await run<{ id: string }>(
          `select ap.id from application ap join unit u on u.id = ap.unit_id join property p on p.id = u.property_id
            where ap.applicant_id = $1 and p.landlord_id = $2`,
          [applicant.id, landlordId],
        )
      ).map((row) => row.id);
      const leases = (
        await run<{ id: string }>(
          `select l.id from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
            where l.applicant_id = $1 and p.landlord_id = $2`,
          [applicant.id, landlordId],
        )
      ).map((row) => row.id);
      const apps = [applications];
      const ls = [leases];

      // Application paperwork and anything recorded about it.
      await collect('select s3_key as key from application_document where application_id = any($1)', apps);
      await run('delete from credit_check where application_id = any($1)', apps);
      await run('delete from application_document where application_id = any($1)', apps);
      // The figures given with each application (applications-create.ts) go with the paperwork.
      await run(
        `update application set notes = null, monthly_income_cents = null, employment_status = null, employer = null
          where id = any($1)`,
        apps,
      );

      // Files on the leases: slips, the lease and invoice PDFs, signatures, inspection reports,
      // the deposit statement, letters of demand, and the photos they took reporting repairs.
      await collect('select s3_key as key from payment_proof where lease_id = any($1)', ls);
      await collect('select pdf_s3_key as key from lease where id = any($1)', ls);
      await collect('select pdf_s3_key as key from invoice where lease_id = any($1)', ls);
      await collect(`select signature_s3_key as key from lease_signature where party = 'tenant' and lease_id = any($1)`, ls);
      await collect(
        `select s.signature_s3_key as key from inspection_signature s join inspection i on i.id = s.inspection_id
          where s.party = 'tenant' and i.lease_id = any($1)`,
        ls,
      );
      await collect('select pdf_s3_key as key from inspection where lease_id = any($1)', ls);
      await collect('select draft_s3_key as key from inspection where lease_id = any($1)', ls);
      await collect('select statement_s3_key as key from termination where lease_id = any($1)', ls);
      await collect(
        `select st.document_s3_key as key from arrears_step st join arrears_case c on c.id = st.case_id
          where c.lease_id = any($1)`,
        ls,
      );
      await collect(
        `select ph.s3_key as key from ticket_photo ph join ticket t on t.id = ph.ticket_id
          where ph.phase = 'report' and t.created_by = $2 and t.lease_id = any($1)`,
        [leases, sub],
      );

      // Their name, email and phone wherever they typed or were quoted in free text. A blank
      // phone must not match (and blank out) everything. The number is stored as +27…, and text
      // often carries it as dialled locally, 08….
      // Every name the record has carried (0044): a message keeps the name it was sent under,
      // and applying elsewhere, or claiming an imported tenancy, changes the record's.
      const fullName = `${applicant.first_name} ${applicant.last_name}`.trim();
      const pastNames = (
        await run<{ name: string }>(
          `select first_name || ' ' || last_name as name from applicant_name where applicant_id = $1`,
          [applicant.id],
        )
      ).map((row) => row.name.trim());
      const namePattern = wholeWords([fullName, ...pastNames]);
      const phone = applicant.phone || 'no phone on record';
      const localPhone = phone.startsWith('+27') ? `0${phone.slice(3)}` : phone;
      const scrub = (column: string) =>
        `replace(replace(replace(regexp_replace(${column}, $2, 'the tenant', 'g'), $3, '[email removed]'), $4, '[phone removed]'), $5, '[phone removed]')`;

      // Payment references carry their name ("N PHIRI LSE-00101"). Before they are cleared below,
      // they go from the activity log, whoever recorded them, and from the messages quoting them.
      const references = [
        ...new Set(
          (
            await run<{ reference: string | null }>(
              `select reference from payment where lease_id = any($1)
               union select reference from payment_proof where lease_id = any($1)`,
              ls,
            )
          )
            .map((row) => row.reference?.trim() ?? '')
            .filter((reference) => reference.length >= 3),
        ),
      ];
      const leaseRefs = (
        await run<{ ref: string }>(`select 'LSE-' || lpad(ref_no::text, 5, '0') as ref from lease where id = any($1)`, ls)
      ).map((row) => row.ref);
      await run(
        `update audit_log set detail = detail - 'reference'
          where jsonb_typeof(detail) = 'object' and detail ? 'reference'
            and entity_id in (select unnest($1::uuid[])
                              union select id from payment where lease_id = any($1)
                              union select id from payment_proof where lease_id = any($1))`,
        ls,
      );
      for (const reference of references) {
        // Whole references only: a plain replace() turned a reference such as 'RENT' inside
        // 'CURRENT' into '[reference removed]'.
        const pattern = `(?<![[:alnum:]])${escapeRegex(reference)}(?![[:alnum:]])`;
        await run(
          `update notification set subject = regexp_replace(subject, $2, '[reference removed]', 'g'),
                                   body = regexp_replace(body, $2, '[reference removed]', 'g')
            where lease_id = any($1) and (subject ~ $2 or body ~ $2)`,
          [leases, pattern],
        );
      }

      // Required keys point at nothing rather than being cleared.
      await run(`update payment_proof set s3_key = 'erased/' || id, reference = null where lease_id = any($1)`, ls);
      await run('update lease set pdf_s3_key = null where id = any($1)', ls);
      await run('update invoice set pdf_s3_key = null where lease_id = any($1)', ls);
      await run(
        `update lease_signature set signature_s3_key = 'erased/' || id, ip_address = null, user_agent = null
          where party = 'tenant' and lease_id = any($1)`,
        ls,
      );
      await run(
        `update inspection_signature set signature_s3_key = 'erased/' || id, ip_address = null, user_agent = null
          where party = 'tenant' and inspection_id in (select id from inspection where lease_id = any($1))`,
        ls,
      );
      await run('update inspection set pdf_s3_key = null, draft_s3_key = null where lease_id = any($1)', ls);
      await run('update termination set statement_s3_key = null where lease_id = any($1)', ls);
      await run(
        `update arrears_step set document_s3_key = 'erased/' || id
          where document_s3_key is not null and case_id in (select id from arrears_case where lease_id = any($1))`,
        ls,
      );
      // What the tenant wrote about repairs, and the photos they took reporting them. The ticket
      // and the completion photos stay: they are the property's maintenance history.
      await run(
        `delete from ticket_photo where phase = 'report'
            and ticket_id in (select id from ticket where created_by = $2 and lease_id = any($1))`,
        [leases, sub],
      );
      // The title is theirs too ("Naledi - burst geyser, call 082…"), but it names the repair,
      // so it loses their details rather than going.
      await run(
        `update ticket set description = '[Removed at the tenant''s request]', rating_note = null, title = ${scrub('title')}
          where created_by = $6 and lease_id = any($1)`,
        [leases, namePattern, applicant.email, phone, localPhone, sub],
      );
      await run(
        `update ticket_event set note = '[Removed at the tenant''s request]'
          where actor_role = 'tenant' and note is not null and ticket_id in (select id from ticket where lease_id = any($1))`,
        ls,
      );
      // Payment references and bank lines carry their name ("N PHIRI LSE-00101").
      await run('update payment set reference = null where lease_id = any($1)', ls);
      await run(`update bank_line set description = '[erased]' where lease_id = any($1)`, ls);
      // Lines never matched to the lease (left unmatched, or ignored as a duplicate) have no
      // lease to find them by: they go when they quote the lease reference, or
      // name the surname, unless another of this landlord's people has that surname too.
      const surname = applicant.last_name.trim();
      const [shared] = await run<{ n: number }>(
        `select count(*)::int as n from applicant a
          where a.id <> $1 and a.erased_at is null and lower(a.last_name) = lower($2)
            and (exists (select 1 from application ap join unit u on u.id = ap.unit_id join property p on p.id = u.property_id
                          where ap.applicant_id = a.id and p.landlord_id = $3)
                 or exists (select 1 from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
                             where l.applicant_id = a.id and p.landlord_id = $3))`,
        [applicant.id, surname, landlordId],
      );
      // Not payment references: those are often generic ('RENT') and would reach other people's lines.
      const lineWords = [...leaseRefs, ...(shared!.n === 0 ? [surname] : [])];
      if (lineWords.length) {
        await run(
          `update bank_line set description = '[erased]'
            where landlord_id = $1 and status <> 'matched' and description ~* $2`,
          [landlordId, wholeWords(lineWords)],
        );
      }
      // Deposits received keep the bank line or slip text they were recorded with
      // ("N PHIRI DEPOSIT LSE-00101"), which the lease statement shows. The note the tenancy
      // import writes is not about the person.
      await run(
        `update deposit_ledger set note = null
          where lease_id = any($1) and entry_type = 'received' and note is not null
            and note <> 'Held before the lease was brought into Threshold'`,
        ls,
      );
      await run('delete from tenant_invite where lease_id = any($1)', ls);

      // The landlord's own messages about this person ("Proof of payment from Naledi Phiri,
      // call 082…") keep their purpose but lose the details.
      await run(
        `update notification set subject = ${scrub('subject')}, body = ${scrub('body')}
          where lease_id = any($1) and recipient_sub is distinct from $6`,
        [leases, namePattern, applicant.email, phone, localPhone, sub],
      );

      // The landlord's applications and leases move to an anonymous stand-in, so the shared
      // record no longer shows this landlord the person's name, contact details or income.
      if (applications.length > 0 || leases.length > 0) {
        const [standIn] = await run<{ id: string }>(
          `insert into applicant (first_name, last_name, email, phone, monthly_income_cents, erased_at)
           values ('Erased', 'person', 'erased-' || gen_random_uuid() || '@invalid', '', 0, now())
           returning id`,
        );
        await run('update lease set applicant_id = $2 where id = any($1)', [leases, standIn!.id]);
        await run('update application set applicant_id = $2 where id = any($1)', [applications, standIn!.id]);

        // What they did on this landlord's records stays in the activity log, by the stand-in:
        // the log named them through their account, which outlives this landlord's erasure.
        const entities = (
          await run<{ id: string }>(
            `select unnest($1::uuid[]) as id
             union select unnest($2::uuid[])
             union select id from ticket where lease_id = any($2)
             union select id from inspection where lease_id = any($2)
             union select id from renewal where lease_id = any($2)
             union select id from termination where lease_id = any($2)
             union select id from payment_proof where lease_id = any($2)`,
            [applications, leases],
          )
        ).map((row) => row.id);
        // Every row about these records loses their name and email, whoever wrote it: a
        // landlord's decline reason or deduction note can name them too.
        await scrubAuditDetails(
          run,
          await run<{ id: string; detail: unknown; own: boolean }>(
            `select id::text, detail, actor_sub is not distinct from $2 as own from audit_log
              where entity_id = any($1) and detail is not null`,
            [entities, sub],
          ),
          [fullName, ...pastNames],
          [applicant.email],
        );
        await run(`update audit_log set actor_sub = 'erased:' || $3 where actor_sub = $1 and entity_id = any($2)`, [
          sub,
          entities,
          standIn!.id,
        ]);
        // Messages addressed to them through a stand-in address (an imported tenant without an
        // account, or an invite) go: they carry their email, first name and old links.
        // Any 'applicant:' address on these leases was theirs: an imported record merged into
        // theirs on claiming (invites-accept.ts) leaves its old id, and a WhatsApp number, behind.
        await run(
          `delete from notification
            where lease_id = any($1)
              and (recipient_sub like 'applicant:%' or recipient_sub like 'tenant-invite:%' or recipient_to = $2)`,
          [leases, applicant.email],
        );
      }
    }

    // The identity goes once no landlord holds an application about this person any more.
    // Every lease hangs off an application, so this covers leases too.
    const [left] = applicant
      ? await run<{ n: number }>('select count(*)::int as n from application where applicant_id = $1', [applicant.id])
      : [{ n: 0 }];
    if (left!.n > 0) return { keys: files, identityErased: false };

    const emails = [...new Set([applicant?.email, credential?.email].filter((e): e is string => Boolean(e)))];
    const pastNames = applicant
      ? (await run<{ name: string }>(`select first_name || ' ' || last_name as name from applicant_name where applicant_id = $1`, [applicant.id]))
          .map((row) => row.name)
      : [];
    const names = [applicant ? `${applicant.first_name} ${applicant.last_name}` : '', credential?.name ?? '', ...pastNames];
    // Their email, name and the IP addresses of their sign-ins in the activity log, on rows
    // about them only: what they did, and sign-ins and resets for their email (those carry no
    // actor). Rewriting every row that contained the name reached other landlords' records,
    // and LIKE read an '_' in an email as any character.
    await scrubAuditDetails(
      run,
      await run<{ id: string; detail: unknown; own: boolean }>(
        `select id::text, detail, true as own from audit_log
          where detail is not null
            and (actor_sub = $1
                 or (jsonb_typeof(detail) = 'object' and lower(detail->>'email') = any($2::text[])))`,
        [sub, emails.map((e) => e.toLowerCase())],
      ),
      names,
      emails,
    );
    // What they agreed to, and when, stays as proof; where from and on what device does not.
    await run('update consent set ip_address = null, user_agent = null where person_sub = $1', [sub]);
    if (applicant) {
      await run(
        `update applicant set first_name = 'Erased', last_name = 'person', id_number_enc = '\\x00',
                id_number_last4 = '0000', email = 'erased-' || id || '@invalid', phone = '',
                employer = null, monthly_income_cents = 0, cognito_sub = null, erased_at = now()
          where id = $1`,
        [applicant.id],
      );
      await run('delete from tenant_invite where applicant_id = $1', [applicant.id]);
      await run('delete from applicant_name where applicant_id = $1', [applicant.id]);
    }
    await run('delete from tenant_invite where accepted_sub = $1', [sub]);
    await run('delete from notification where recipient_sub = $1', [sub]);
    // Messages sent to their address under another name: invites, and notices to an imported
    // tenant before they had an account.
    // Not another landlord's messages to the same address on a record of their own (a tenancy
    // they imported for this email, never claimed): that landlord still holds the tenancy.
    for (const email of emails) {
      await run(
        `delete from notification n
          where lower(n.recipient_to) = lower($1)
            and not exists (
              select 1 from applicant o
               where o.id is distinct from $2::uuid and o.erased_at is null
                 and (n.recipient_sub = 'applicant:' || o.id
                      or n.lease_id in (select l.id from lease l where l.applicant_id = o.id)))`,
        [email, applicant?.id ?? null],
      );
    }
    if (applicant) await run(`delete from notification where recipient_sub = 'applicant:' || $1`, [applicant.id]);
    await run('delete from notification_preference where person_sub = $1', [sub]);
    // What they wrote when asking for erasure ("I am Naledi Phiri, ID …").
    await run('update privacy_request set note = null where person_sub = $1', [sub]);
    // Password reset links and recovery codes go with the sign-in (on delete cascade).
    await run('delete from local_credential where sub = $1', [sub]);
    return { keys: files, identityErased: true };
  });

  // After the commit: a file or sign-in that fails to delete is logged and retried by hand,
  // never a reason to leave the person's details in the database.
  for (const key of keys) {
    await storage()
      .remove(key)
      .catch((error) => logger.error('Erasure could not delete a file.', { key, error }));
  }

  await audit({
    actorSub: actor.sub,
    actorRole: actor.role,
    action: 'privacy.erased',
    entity: 'person',
    entityId: null,
    detail: { personSub: sub, files: keys.length, landlordId, identityErased, ...(scope.replayOf ? { replayOf: scope.replayOf } : {}) },
  });
  // Last: Cognito sits outside the VPC. A slow call that ran into the Lambda timeout used to
  // leave the files and the privacy.erased row (which the sweep relies on) undone.
  if (identityErased) await removeSignIn(sub);
  return { files: keys.length, identityErased };
}

/** An erasure as restore.sh and backup.sh list it: which 'privacy.erased' row, whose, by whom. */
export interface RecordedErasure {
  /** `<audit id>@<at, UTC, to the microsecond>`, or the replayOf of a replayed row: an id alone
      is reused once a restore rewinds the sequence. to_char, not extract(epoch): that prints
      differently from Postgres 14 on, and a key must read the same on any server. */
  key: string;
  personSub: string;
  landlordId: string | null;
}

/** Lines of `epoch|key|personSub|landlordId`, as psql -At -F '|' prints them. */
export function parseErasureList(text: string): RecordedErasure[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [, key, personSub, landlordId] = line.split('|');
      if (!key || !personSub) throw new Error(`Not an erasure line: ${line}`);
      return { key, personSub, landlordId: landlordId || null };
    });
}

/**
 * After a restore, erasures done since the dump are done again: the backup holds the person as
 * they were, sign-in included. Each runs once; one the restored database already records (or
 * replayed before) is skipped. The retention rule was checked when the erasure was first made.
 */
export async function replayErasures(list: RecordedErasure[]): Promise<number> {
  let replayed = 0;
  for (const erasure of list) {
    const [done] = await query(
      `select 1 from audit_log
        where action = 'privacy.erased'
          and coalesce(detail->>'replayOf', id::text || '@' || to_char(at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')) = $1
        limit 1`,
      [erasure.key],
    );
    if (done) continue;
    await erasePerson(
      erasure.personSub,
      { sub: 'system:restore', role: 'system' },
      { ...(erasure.landlordId ? { landlordId: erasure.landlordId } : {}), replayOf: erasure.key },
    );
    replayed += 1;
  }
  return replayed;
}

/** A message straight to an address, outside preferences: the person asked for this answer. */
export async function tellPerson(run: Run | null, sub: string, email: string, subject: string, body: string) {
  const execute: Run = run ?? ((sql, params) => query(sql, params) as Promise<never[]>);
  await execute(
    `insert into notification (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
     values ($1, $2, 'email', 'account', 'privacy_request', false, $3, $4)`,
    [sub, email, subject, body],
  );
}
