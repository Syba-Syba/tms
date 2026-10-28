import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, EmptyState, PageHeader } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { Ledger } from '../components/money';
import { formatDate, status } from '../lib/format';
import { QueryState } from '../components/query-state';
import { currentLease } from '../lib/leases';
import { useOpenDocument } from '../lib/open-document';

interface Lease {
  id: string; ref: string; unit: string; startDate: string; endDate: string; hasDocument: boolean;
  pdfKey: string | null;
  inspections: { id: string; kind: string; status: string; scheduledFor: string; flagged: number; reportKey: string | null }[];
  invoices: { id: string; period: string; dueOn: string; totalCents: number; status: string; pdfKey: string | null }[];
  termination: { refundDueBy: string | null; statementKey: string | null } | null;
}

/** Everything on the tenancy that is a document, in one place, because when something is
    disputed this is the list a tribunal asks for. */
export function Documents() {
  const openDocument = useOpenDocument();
  const list = useQuery({
    queryKey: ['leases'],
    queryFn: () => api.get<{ items: { id: string; status: string }[] }>('/leases'),
  });
  // The current tenancy's documents, not an accepted renewal's that has not started yet.
  const leaseId = currentLease(list.data?.items ?? [])?.id;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<Lease>(`/leases/${leaseId}`),
    enabled: Boolean(leaseId),
  });

  if (!data) {
    // "Nothing filed yet" is only true once the list has actually answered with no lease.
    if (list.isSuccess && !leaseId) {
      return (
        <main className="mx-auto max-w-2xl px-5 py-6">
          <EmptyState title="Nothing filed yet" description="Documents appear as your tenancy produces them." />
        </main>
      );
    }
    return (
      <QueryState
        isLoading={list.isLoading || isLoading}
        isError={list.isError || isError}
        error={list.error ?? error}
        onRetry={() => (list.isError ? list.refetch() : refetch())}
        what="Your documents"
      />
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-6">
      <PageHeader
        title="Documents"
        description="Your lease, every inspection and every invoice. Keep these; they are what settles a dispute."
      />

      <p className="label mb-2">Lease</p>
      <Card className="mb-5">
        <CardBody className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">{data.ref}</p>
            <p className="text-xs text-ink-muted">
              {data.unit} · {formatDate(data.startDate)} to {formatDate(data.endDate)}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-3">
            {data.pdfKey ? (
              <Button size="sm" variant="outline" onClick={() => openDocument(data.pdfKey!)}>
                Open
              </Button>
            ) : null}
            <Badge tone={data.hasDocument ? 'success' : 'neutral'}>
              {data.hasDocument ? 'Signed' : 'Not issued'}
            </Badge>
          </span>
        </CardBody>
      </Card>

      <p className="label mb-2">
        Inspections
      </p>
      <Card className="mb-5">
        <CardBody className="space-y-3">
          {data.inspections.length === 0 ? (
            <p className="text-[13.5px] text-ink-muted">
              None yet. The move-in inspection and its defects list become part of your lease.
            </p>
          ) : null}
          {data.inspections.map((inspection) => (
            <div key={inspection.id} className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-semibold capitalize">
                  {inspection.kind === 'incoming' ? 'Move in' : 'Move out'} · {formatDate(inspection.scheduledFor)}
                </p>
                <p className="text-xs text-ink-muted">
                  {inspection.flagged > 0 ? `${inspection.flagged} items flagged` : 'Nothing flagged'}
                </p>
              </div>
              <span className="flex items-center gap-3">
                {inspection.reportKey ? (
                  <Button size="sm" variant="outline" onClick={() => openDocument(inspection.reportKey!)}>
                    Open
                  </Button>
                ) : null}
                <Badge tone={inspection.status === 'completed' ? 'success' : 'warning'}>
                  {status(inspection.status).label}
                </Badge>
              </span>
            </div>
          ))}
        </CardBody>
      </Card>

      {data.termination?.statementKey ? (
        <>
          <p className="label mb-2">
            Deposit statement
          </p>
          <Card className="mb-5">
            <CardBody className="flex items-center justify-between">
              <p className="text-[14px]">
                The final reconciliation of your deposit, its interest and every deduction.
              </p>
              <Button size="sm" variant="outline" onClick={() => openDocument(data.termination!.statementKey!)}>
                Open
              </Button>
            </CardBody>
          </Card>
        </>
      ) : null}

      <p className="label mb-2">Invoices</p>
      <Card>
        <CardBody className="space-y-2">
          {data.invoices.length === 0 ? (
            <p className="text-[13.5px] text-ink-muted">None issued yet.</p>
          ) : null}
          {data.invoices.map((invoice) => (
            <div
              key={invoice.id}
              className="flex items-center justify-between border-b border-line-soft pb-2 last:border-0"
            >
              <div>
                <p className="text-[14px] font-semibold">{invoice.period}</p>
                <p className="text-xs text-ink-muted">Due {formatDate(invoice.dueOn)}</p>
              </div>
              <div className="flex items-center gap-3">
                <Ledger cents={invoice.totalCents} className="text-[15px]" />
                <Badge tone={status(invoice.status).tone}>{status(invoice.status).label}</Badge>
                <button
                  type="button"
                  className="text-[13px] font-bold text-brand-500"
                  onClick={() =>
                    openDocument(
                      invoice.pdfKey ??
                        (async () => (await api.post<{ key: string }>(`/invoices/${invoice.id}/render`, {})).key),
                    )
                  }
                >
                  PDF
                </button>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
    </main>
  );
}
