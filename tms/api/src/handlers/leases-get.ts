import { requireLeaseAccess } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, json, notFound, route } from '../lib/http';

/** Everything hanging off one lease, so the detail screen is a single request. */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);

  const [lease] = await query<{
    id: string; ref: string; status: string; start_date: string; end_date: string;
    monthly_rent_cents: string; escalation_pct: string; deposit_cents: string;
    unit: string; tenant: string; tenant_email: string; pdf_sha256: string | null;
    pdf_s3_key: string | null;
  }>(
    `select l.id, 'LSE-' || lpad(l.ref_no::text, 5, '0') as ref, l.status,
            l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.escalation_pct,
            l.deposit_cents, p.name || ' ' || u.code as unit,
            a.first_name || ' ' || a.last_name as tenant, a.email as tenant_email,
            l.pdf_sha256, l.pdf_s3_key
       from lease l
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join applicant a on a.id = l.applicant_id
      where l.id = $1`,
    [leaseId],
  );
  if (!lease) throw notFound('Lease');

  const inspections = await query<{
    report_key: string | null;
    id: string; kind: string; status: string; scheduled_for: string; findings: string; flagged: string;
  }>(
    `select i.id, i.kind, i.status, i.scheduled_for::text, i.pdf_s3_key as report_key,
            (select count(*) from inspection_finding f where f.inspection_id = i.id)::text as findings,
            (select count(*) from inspection_finding f
              where f.inspection_id = i.id
                and f.condition in ('poor','damaged','missing'))::text as flagged
       from inspection i where i.lease_id = $1 order by i.scheduled_for`,
    [leaseId],
  );

  const [termination] = await query<{
    id: string; status: string; reason: string; notice_given_on: string; effective_on: string;
    refund_due_by: string | null; deductions: string; statement_s3_key: string | null;
  }>(
    `select t.id, t.status, t.reason, t.notice_given_on::text, t.effective_on::text, t.statement_s3_key,
            t.refund_due_by::text,
            (select count(*) from deposit_deduction d where d.termination_id = t.id)::text as deductions
       from termination t where t.lease_id = $1 and t.status <> 'withdrawn'`,
    [leaseId],
  );

  const [renewal] = await query<{
    id: string; status: string; respond_by: string; new_start_date: string; new_end_date: string;
    new_rent_cents: string; deposit_top_up_cents: string;
  }>(
    `select id, status, respond_by::text, new_start_date::text, new_end_date::text,
            new_rent_cents, deposit_top_up_cents
       from renewal where lease_id = $1 and status = 'offered'`,
    [leaseId],
  );

  // The lease that follows this one, once a renewal is accepted. Until both have signed it the
  // tenancy carries on under this lease, so the page has to say where to sign.
  const [next] = await query<{ id: string; ref: string; status: string; start_date: string; signatures: string }>(
    `select n.id, 'LSE-' || lpad(n.ref_no::text, 5, '0') as ref, n.status, n.start_date::text,
            (select count(*) from lease_signature s where s.lease_id = n.id)::text as signatures
       from lease n
      where n.previous_lease_id = $1 and n.status in ('scheduled', 'active')`,
    [leaseId],
  );

  const signatures = await query<{ party: string; signed_at: string }>(
    'select party, signed_at from lease_signature where lease_id = $1',
    [leaseId],
  );

  const invoices = await query<{
    id: string; period: string; due_on: string; total_cents: string; status: string; paid: string;
    pdf_s3_key: string | null;
  }>(
    `select i.id, to_char(i.period_start, 'FMMonth YYYY') as period, i.due_on::text,
            i.total_cents, i.status, i.pdf_s3_key,
            coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid
       from invoice i where i.lease_id = $1 order by i.period_start desc limit 12`,
    [leaseId],
  );

  return json(200, {
    id: lease.id,
    ref: lease.ref,
    status: lease.status,
    unit: lease.unit,
    tenant: lease.tenant,
    tenantEmail: lease.tenant_email,
    startDate: lease.start_date,
    endDate: lease.end_date,
    monthlyRentCents: Number(lease.monthly_rent_cents),
    escalationPct: Number(lease.escalation_pct),
    depositCents: Number(lease.deposit_cents),
    hasDocument: Boolean(lease.pdf_sha256),
    pdfKey: lease.pdf_s3_key,
    pdfSha256: lease.pdf_sha256,
    signatures: signatures.map((row) => ({ party: row.party, signedAt: row.signed_at })),
    viewer: { isLandlord: access.isLandlord, isTenant: access.isTenant },
    inspections: inspections.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      scheduledFor: row.scheduled_for,
      findings: Number(row.findings),
      flagged: Number(row.flagged),
      reportKey: row.report_key,
    })),
    termination: termination
      ? {
          id: termination.id,
          status: termination.status,
          reason: termination.reason,
          noticeGivenOn: termination.notice_given_on,
          effectiveOn: termination.effective_on,
          refundDueBy: termination.refund_due_by,
          statementKey: termination.statement_s3_key,
          deductions: Number(termination.deductions),
        }
      : null,
    renewal: renewal
      ? {
          id: renewal.id,
          status: renewal.status,
          respondBy: renewal.respond_by,
          newStartDate: renewal.new_start_date,
          newEndDate: renewal.new_end_date,
          newRentCents: Number(renewal.new_rent_cents),
          depositTopUpCents: Number(renewal.deposit_top_up_cents),
        }
      : null,
    renewedBy: next
      ? {
          id: next.id,
          ref: next.ref,
          status: next.status,
          startDate: next.start_date,
          signaturesOnFile: Number(next.signatures),
        }
      : null,
    invoices: invoices.map((row) => ({
      id: row.id,
      period: row.period,
      dueOn: row.due_on,
      totalCents: Number(row.total_cents),
      paidCents: Number(row.paid),
      status: row.status,
      pdfKey: row.pdf_s3_key,
    })),
  });
});
