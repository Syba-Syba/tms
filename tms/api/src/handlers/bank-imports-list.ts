import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

export const handler = route(async (event) => {
  const landlordId = await landlordIdFor(requireLandlord(event));
  const rows = await query<{
    id: string; file_name: string; format: string; created_at: string;
    lines: string; unmatched: string; matched: string;
  }>(
    `select b.id, b.file_name, b.format, b.created_at::text,
            count(l.id)::text as lines,
            count(l.id) filter (where l.status = 'unmatched')::text as unmatched,
            count(l.id) filter (where l.status = 'matched')::text as matched
       from bank_import b
       left join bank_line l on l.import_id = b.id
      where b.landlord_id = $1
      group by b.id
      order by b.created_at desc
      limit 50`,
    [landlordId],
  );
  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      format: row.format,
      importedAt: row.created_at,
      lines: Number(row.lines),
      unmatched: Number(row.unmatched),
      matched: Number(row.matched),
    })),
  });
});
