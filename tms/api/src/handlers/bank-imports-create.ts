import { z } from 'zod';
import { landlordIdFor } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { importDetail } from '../lib/bank';
import { withTransaction } from '../lib/db';
import { badRequest, json, parseBody, route } from '../lib/http';
import { parseStatement, StatementError } from '../domain/bank-statement';

const schema = z.object({
  fileName: z.string().trim().min(1).max(200),
  // A year of a busy account is a few hundred kilobytes; the server caps bodies at 1 MB.
  content: z.string().min(1).max(900_000, 'That file is too large. Export a shorter date range.'),
});

/**
 * Reads the statement, keeps the credits, and stores each one once. Lines already imported
 * from an overlapping statement are counted and skipped, never recorded twice.
 */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const landlordId = await landlordIdFor(person);
  const input = parseBody(event, schema);

  let parsed;
  try {
    parsed = parseStatement(input.fileName, input.content);
  } catch (error) {
    if (error instanceof StatementError) throw badRequest(error.message);
    throw error;
  }

  const { importId, added } = await withTransaction(async (run) => {
    const [created] = await run<{ id: string }>(
      `insert into bank_import (landlord_id, file_name, format, imported_by)
       values ($1, $2, $3, $4) returning id`,
      [landlordId, input.fileName, parsed.format, person.sub],
    );
    // One statement for every line: one insert per line held the connection for tens of
    // seconds on a large file. A line on file under its old OFX fingerprint (before the
    // account was part of it), with the same date and amount, was imported already.
    const lines = parsed.lines;
    const inserted = await run<{ id: string }>(
      `insert into bank_line (import_id, landlord_id, posted_on, amount_cents, description, fingerprint)
       select $1, $2, l.posted_on, l.amount_cents, l.description, l.fingerprint
         from unnest($3::date[], $4::bigint[], $5::text[], $6::text[], $7::text[])
              as l(posted_on, amount_cents, description, fingerprint, legacy)
        where l.legacy is null
           or not exists (select 1 from bank_line b
                           where b.landlord_id = $2 and b.fingerprint = l.legacy
                             and b.posted_on = l.posted_on and b.amount_cents = l.amount_cents)
       on conflict (landlord_id, fingerprint) do nothing
       returning id`,
      [
        created!.id,
        landlordId,
        lines.map((line) => line.postedOn),
        lines.map((line) => line.amountCents),
        lines.map((line) => line.description.slice(0, 300)),
        lines.map((line) => line.fingerprint),
        lines.map((line) => line.legacyFingerprint ?? null),
      ],
    );
    return { importId: created!.id, added: inserted.length };
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: 'bank_import.created',
    entity: 'bank_import',
    entityId: importId,
    detail: { fileName: input.fileName, format: parsed.format, credits: parsed.lines.length, added },
  });

  const detail = await importDetail(importId, landlordId);
  return json(201, {
    ...detail,
    summary: {
      credits: parsed.lines.length,
      added,
      alreadyImported: parsed.lines.length - added,
      debitsSkipped: parsed.debitsSkipped,
    },
  });
});
