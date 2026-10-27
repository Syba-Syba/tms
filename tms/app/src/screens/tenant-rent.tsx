import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { Badge, Button, Card, CardBody, PageHeader, TagField } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api } from '../api/client';
import { QueryState } from '../components/query-state';

interface Statement {
  ref: string | null;
  balanceCents: number;
  depositBalanceCents: number;
  invoices: { id: string; period: string; dueOn: string; totalCents: number; status: string }[];
  payments: { id: string; amountCents: number; receivedOn: string; reference: string | null }[];
}

const tone = { paid: 'success', part_paid: 'warning', issued: 'neutral' } as const;

const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

/** There is no server-rendered PDF for a running statement, only for the exit statement, so
    the download is built from the same rows the screen is already showing. CSV, because the
    thing a tenant does with this is hand it to a bank or paste it into a dispute. */
function statementCsv(statement: Statement): string {
  const rows: (string | number)[][] = [['Date', 'Description', 'Reference', 'Debit', 'Credit']];
  for (const invoice of statement.invoices) {
    rows.push([invoice.dueOn, `Rent ${invoice.period}`, '', (invoice.totalCents / 100).toFixed(2), '']);
  }
  for (const payment of statement.payments) {
    rows.push([payment.receivedOn, 'Payment received', payment.reference ?? '', '', (payment.amountCents / 100).toFixed(2)]);
  }
  rows.push([]);
  rows.push(['', 'Balance outstanding', '', (statement.balanceCents / 100).toFixed(2), '']);
  rows.push(['', 'Deposit held', '', '', (statement.depositBalanceCents / 100).toFixed(2)]);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

export function TenantRent() {
  const { leaseId } = useParams();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['statement', leaseId],
    queryFn: () => api.get<Statement>(`/leases/${leaseId}/statement`),
  });

  const balance = data?.balanceCents ?? 0;

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([statementCsv(data)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `statement-${leaseId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your statement" />;
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title="Rent"
        description={balance <= 0 ? 'You are fully paid up.' : `${formatZar(balance / 100)} outstanding.`}
      />
      <Card className="mb-4">
        <CardBody className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-widest text-ink-muted">Pay by EFT with this reference</p>
          {/* The lease's own reference: it is how the bank statement is matched to this unit. */}
          <TagField label="Reference" value={data.ref ?? 'Ask your landlord'} />
          <p className="text-xs text-ink-muted">
            Your deposit stands at {formatZar(data.depositBalanceCents / 100)}, interest included.
            It is yours; it grows every month.
          </p>
        </CardBody>
      </Card>
      <div className="space-y-3">
        {data.invoices.map((invoice) => (
          <Card key={invoice.id}>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[15px] font-semibold text-ink">{invoice.period}</p>
                <p className="text-xs text-ink-muted">Due {invoice.dueOn}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm">{formatZar(invoice.totalCents / 100)}</span>
                <Badge tone={tone[invoice.status as keyof typeof tone] ?? 'neutral'}>
                  {invoice.status.replace('_', ' ')}
                </Badge>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
      <Button block variant="secondary" className="mt-5" onClick={download}>
        Download statement
      </Button>
    </main>
  );
}
