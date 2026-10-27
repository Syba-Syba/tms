import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';
import { ageBucket, type AgeBucket } from '../domain/money';

const BUCKETS: AgeBucket[] = ['current', 'd30', 'd60', 'd90', 'd90plus'];
const empty = () => Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<AgeBucket, number>;

/**
 * Age analysis: what each tenant owes, split by how long it has been owed. The same buckets as
 * the tenant's own statement, so both sides argue from one set of numbers.
 */
export const handler = route(async (event) => {
  const landlordId = await landlordIdFor(requireLandlord(event));
  const open = await query<{
    lease_id: string; lease_ref: string; tenant: string; unit: string; due_on: string; outstanding: string;
    proof_pending: boolean;
  }>(
    `select l.id as lease_id, 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
            a.first_name || ' ' || a.last_name as tenant, pr.name || ' ' || u.code as unit,
            i.due_on::text,
            (i.total_cents - coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0))::text
              as outstanding,
            exists (select 1 from payment_proof pp where pp.lease_id = l.id and pp.status = 'pending') as proof_pending
       from invoice i
       join lease l on l.id = i.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
      where pr.landlord_id = $1 and i.status in ('issued', 'part_paid')
      order by pr.name, u.code, i.due_on`,
    [landlordId],
  );

  const today = new Date();
  const byLease = new Map<string, {
    leaseId: string; leaseRef: string; tenant: string; unit: string; oldestDueOn: string;
    proofPending: boolean; ageing: Record<AgeBucket, number>; totalCents: number;
  }>();
  const totals = empty();
  for (const row of open) {
    const amount = Number(row.outstanding);
    if (amount <= 0) continue;
    const bucket = ageBucket(new Date(row.due_on), today);
    const lease = byLease.get(row.lease_id) ?? {
      leaseId: row.lease_id, leaseRef: row.lease_ref, tenant: row.tenant, unit: row.unit,
      oldestDueOn: row.due_on, proofPending: row.proof_pending, ageing: empty(), totalCents: 0,
    };
    lease.ageing[bucket] += amount;
    lease.totalCents += amount;
    totals[bucket] += amount;
    byLease.set(row.lease_id, lease);
  }
  const items = [...byLease.values()].sort((a, b) => b.totalCents - a.totalCents);
  return json(200, {
    asOf: today.toISOString().slice(0, 10),
    items,
    totals: { ageing: totals, totalCents: Object.values(totals).reduce((sum, value) => sum + value, 0) },
  });
});
