import { z } from 'zod';
import { membershipOf } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { badRequest, json, parseBody, route } from '../lib/http';
import { importTenancies } from '../lib/tenancy-import';
import { MAX_ROWS, parseTenancyCsv } from '../domain/tenancy-import';

const schema = z
  .object({
    rows: z.array(z.record(z.string(), z.unknown())).max(MAX_ROWS).optional(),
    csv: z.string().max(2_000_000).optional(),
    // Checks everything and writes nothing: the preview before the real import.
    dryRun: z.boolean().default(true),
    invite: z.boolean().default(false),
  })
  .refine((input) => Boolean(input.rows) !== Boolean(input.csv), 'Send rows or a csv, not both.');

/**
 * Brings tenancies that began before Threshold into it: from the add-a-tenant form as one row,
 * or from a spreadsheet. A dry run reports every problem by line; the real run writes all the
 * rows or none.
 */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await membershipOf(person);
  const input = parseBody(event, schema);

  let items: { line: number; input: unknown; problems?: string[] }[];
  if (input.csv !== undefined) {
    const parsed = parseTenancyCsv(input.csv);
    if (parsed.missingColumns.length > 0) {
      throw badRequest(`The spreadsheet needs these columns: ${parsed.missingColumns.join(', ')}. Start from the template.`);
    }
    if (parsed.rows.length === 0) throw badRequest('The spreadsheet has no tenancies in it.');
    if (parsed.rows.length > MAX_ROWS) throw badRequest(`Import at most ${MAX_ROWS} tenancies at a time.`);
    items = parsed.rows;
  } else {
    items = input.rows!.map((row, index) => ({ line: index + 1, input: row }));
    if (items.length === 0) throw badRequest('Nothing to import.');
  }

  const result = await importTenancies(landlordId, items, { actorSub: person.sub, dryRun: input.dryRun, invite: input.invite });
  return json(input.dryRun || result.failed > 0 ? 200 : 201, { dryRun: input.dryRun, ...result });
});
