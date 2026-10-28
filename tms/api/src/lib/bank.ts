import { query } from './db';
import { suggestLease, type LeaseCandidate } from '../domain/bank-match';

/** Leases a landlord's bank credits can belong to, with what each owes right now. */
export async function leaseCandidates(landlordId: string): Promise<Array<LeaseCandidate & { label: string }>> {
  const rows = await query<{
    lease_id: string; ref_no: string; surname: string; tenant: string; unit: string;
    owed_cents: string; proofs: number[] | null;
  }>(
    `select l.id as lease_id, l.ref_no::text, a.last_name as surname,
            a.first_name || ' ' || a.last_name as tenant, pr.name || ' ' || u.code as unit,
            coalesce((
              select sum(i.total_cents - coalesce((
                       select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0))
                from invoice i
               where i.lease_id = l.id and i.status in ('issued', 'part_paid')), 0)::text as owed_cents,
            (select array_agg(pp.amount_cents::int) from payment_proof pp
              where pp.lease_id = l.id and pp.status = 'pending') as proofs
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
      where pr.landlord_id = $1
        and l.status in ('out_for_signature', 'active', 'terminated')
      order by pr.name, u.code`,
    [landlordId],
  );
  return rows.map((row) => ({
    leaseId: row.lease_id,
    refNo: Number(row.ref_no),
    tenantSurname: row.surname,
    owedCents: Number(row.owed_cents),
    pendingProofCents: (row.proofs ?? []).map(Number),
    label: `${row.unit}, ${row.tenant} (LSE-${row.ref_no.padStart(5, '0')})`,
  }));
}

/** One import with its lines. Suggestions are worked out now, against what is owed now. */
export async function importDetail(importId: string, landlordId: string) {
  const [header] = await query<{ id: string; file_name: string; format: string; created_at: string }>(
    `select id, file_name, format, created_at::text from bank_import where id = $1 and landlord_id = $2`,
    [importId, landlordId],
  );
  if (!header) return null;
  const lines = await query<{
    id: string; posted_on: string; amount_cents: string; description: string; status: string; lease_id: string | null;
  }>(
    `select id, posted_on::text, amount_cents, description, status, lease_id
       from bank_line where import_id = $1 order by posted_on, id`,
    [importId],
  );
  const leases = await leaseCandidates(landlordId);
  return {
    id: header.id,
    fileName: header.file_name,
    format: header.format,
    importedAt: header.created_at,
    leases: leases.map((lease) => ({ leaseId: lease.leaseId, label: lease.label, owedCents: lease.owedCents })),
    lines: lines.map((line) => {
      const amountCents = Number(line.amount_cents);
      return {
        id: line.id,
        postedOn: line.posted_on,
        amountCents,
        description: line.description,
        status: line.status,
        leaseId: line.lease_id,
        suggestion: line.status === 'unmatched' ? suggestLease({ amountCents, description: line.description }, leases) : null,
      };
    }),
  };
}
