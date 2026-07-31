import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Badge, Button, Card, CardBody, PageHeader, TagField } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api } from '../api/client';

interface Statement {
  balanceCents: number;
  depositBalanceCents: number;
  invoices: { id: string; period: string; dueOn: string; totalCents: number; status: string }[];
  payments: { id: string; amountCents: number; receivedOn: string; reference: string | null }[];
}

const tone = { paid: 'success', part_paid: 'warning', issued: 'neutral' } as const;

export function TenantRent() {
  const { leaseId } = useParams();
  const { data } = useQuery({
    queryKey: ['statement', leaseId],
    queryFn: () => api.get<Statement>(`/leases/${leaseId}/statement`),
  });

  const balance = data?.balanceCents ?? 0;

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title="Rent"
        description={balance <= 0 ? 'You are fully paid up.' : `${formatZar(balance / 100)} outstanding.`}
      />
      <Card className="mb-4">
        <CardBody className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-widest text-ink-muted">Pay by EFT with this reference</p>
          <TagField label="Reference" value="LSE-00184" />
          <p className="text-xs text-ink-muted">
            Your deposit stands at {formatZar((data?.depositBalanceCents ?? 0) / 100)}, interest included.
            It is yours; it grows every month.
          </p>
        </CardBody>
      </Card>
      <div className="space-y-3">
        {data?.invoices.map((invoice) => (
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
      <Button block variant="secondary" className="mt-5">
        Download statement
      </Button>
    </main>
  );
}
