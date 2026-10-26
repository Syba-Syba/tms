import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, CurrencyInput, Input, Modal, PageHeader, Select, Spinner, useToast,
} from '@hlonie/toolbox/ui';
import { api, openDocument, humanError } from '../api/client';
import { Ledger } from '../components/money';

interface Lease {
  id: string; ref: string; status: string; unit: string; tenant: string;
  startDate: string; endDate: string; monthlyRentCents: number; escalationPct: number;
  depositCents: number; hasDocument: boolean; pdfKey: string | null;
  viewer: { isLandlord: boolean; isTenant: boolean };
  inspections: { id: string; kind: string; status: string; scheduledFor: string; findings: number; flagged: number; reportKey: string | null }[];
  termination: { id: string; status: string; effectiveOn: string; noticeGivenOn: string; refundDueBy: string | null; deductions: number; statementKey: string | null } | null;
  renewal: { id: string; respondBy: string; newStartDate: string; newEndDate: string; newRentCents: number; depositTopUpCents: number } | null;
  invoices: { id: string; period: string; dueOn: string; totalCents: number; paidCents: number; status: string; pdfKey: string | null }[];
}

const today = () => new Date().toISOString().slice(0, 10);

export function LeaseDetail() {
  const { leaseId } = useParams();
  const toast = useToast();
  const [payment, setPayment] = useState({ amountCents: 0, reference: '', invoiceId: '' });
  const [showPayment, setShowPayment] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [notice, setNotice] = useState({ reason: 'end_of_term', initiatedBy: 'landlord' });
  const [showRenewal, setShowRenewal] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<Lease>(`/leases/${leaseId}`),
  });

  const run = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      toast.show({ title: message, tone: 'success' });
      refetch();
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
    }
  };

  if (isLoading || !data) return <main className="p-16 text-center"><Spinner /></main>;
  const landlord = data.viewer.isLandlord;
  const open = data.invoices.filter((i) => i.status !== 'paid');

  return (
    <main className="mx-auto max-w-3xl px-5 py-6">
      <PageHeader title={data.unit} description={`${data.ref} · ${data.tenant}`} />

      {data.status === 'out_for_signature' ? (
        <Alert tone="info" title="Out for signature" className="mb-4">
          <Link to={`/lease/${data.id}`} className="font-bold text-brand-500">
            Open the signing page
          </Link>{' '}
          to review the document and sign.
        </Alert>
      ) : null}

      <Card className="mb-4">
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ['Rent', <Ledger key="r" cents={data.monthlyRentCents} className="text-[19px]" />],
            ['Deposit', <Ledger key="d" cents={data.depositCents} className="text-[19px]" />],
            ['Escalation', <span key="e" className="text-[19px] font-extrabold">{data.escalationPct}%</span>],
            ['Ends', <span key="x" className="text-[15px] font-semibold">{data.endDate}</span>],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">{label}</p>
              {value}
            </div>
          ))}
        </CardBody>
      </Card>

      {data.pdfKey ? (
        <button
          type="button"
          className="mb-4 text-[13.5px] font-bold text-brand-500"
          onClick={() => openDocument(data.pdfKey!)}
        >
          Open the lease agreement
        </button>
      ) : null}

      {data.renewal ? (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <p className="text-[10.5px] font-bold uppercase tracking-widest text-brand-500">
              Renewal offered · answer by {data.renewal.respondBy}
            </p>
            <p className="text-[15px]">
              {data.renewal.newStartDate} to {data.renewal.newEndDate} at{' '}
              <Ledger cents={data.renewal.newRentCents} /> a month.
            </p>
            {data.renewal.depositTopUpCents > 0 ? (
              <p className="text-[13px] text-ink-muted">
                Deposit top-up of <Ledger cents={data.renewal.depositTopUpCents} />. Your existing
                deposit and its interest carry across.
              </p>
            ) : null}
            {data.viewer.isTenant ? (
              <div className="flex gap-2">
                <Button
                  onClick={() =>
                    run(
                      () => api.post(`/renewals/${data.renewal!.id}/decision`, { decision: 'accept' }),
                      'Renewal accepted',
                    )
                  }
                >
                  Accept
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    run(
                      () => api.post(`/renewals/${data.renewal!.id}/decision`, { decision: 'decline' }),
                      'Renewal declined',
                    )
                  }
                >
                  Decline
                </Button>
              </div>
            ) : (
              <p className="text-[13px] text-ink-muted">Waiting on the tenant.</p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {data.termination ? (
        <Alert tone="warning" title={`Lease ends ${data.termination.effectiveOn}`} className="mb-4">
          Notice served {data.termination.noticeGivenOn}. The exit inspection must happen in the
          final three days, with both of you there. Skip it and the law treats the place as
          undamaged, so nothing can be deducted.
          {data.termination.refundDueBy ? ` Refund due by ${data.termination.refundDueBy}.` : ''}
        </Alert>
      ) : null}

      <p className="mb-2 text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">Invoices</p>
      <Card className="mb-4">
        <CardBody className="space-y-2">
          {data.invoices.length === 0 ? (
            <p className="text-[13.5px] text-ink-muted">
              None yet. The run issues next month's rent on the 25th.
            </p>
          ) : null}
          {data.invoices.map((invoice) => (
            <div key={invoice.id} className="flex items-center justify-between border-b border-line-soft pb-2 last:border-0">
              <div>
                <p className="text-[14px] font-semibold">{invoice.period}</p>
                <p className="text-xs text-ink-muted">Due {invoice.dueOn}</p>
              </div>
              <div className="flex items-center gap-3">
                <Ledger cents={invoice.totalCents} className="text-[15px]" />
                <Badge tone={invoice.status === 'paid' ? 'success' : 'warning'}>
                  {invoice.status.replace('_', ' ')}
                </Badge>
                <button
                  type="button"
                  className="text-[13px] font-bold text-brand-500"
                  onClick={async () => {
                    let key = invoice.pdfKey;
                    if (!key) {
                      const rendered = await api.post<{ key: string }>(`/invoices/${invoice.id}/render`, {});
                      key = rendered.key;
                      refetch();
                    }
                    await openDocument(key);
                  }}
                >
                  PDF
                </button>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      <p className="mb-2 text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">Inspections</p>
      <Card className="mb-4">
        <CardBody className="space-y-2">
          {data.inspections.length === 0 ? (
            <p className="text-[13.5px] text-ink-muted">None booked.</p>
          ) : null}
          {data.inspections.map((inspection) => (
            <div key={inspection.id} className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-semibold capitalize">{inspection.kind} · {inspection.scheduledFor}</p>
                <p className="text-xs text-ink-muted">
                  {inspection.findings} items{inspection.flagged ? `, ${inspection.flagged} flagged` : ''}
                </p>
              </div>
              <span className="flex items-center gap-3">
                {inspection.reportKey ? (
                  <button
                    type="button"
                    className="text-[13px] font-bold text-brand-500"
                    onClick={() => openDocument(inspection.reportKey!)}
                  >
                    Report
                  </button>
                ) : null}
                <Link to={`/inspections/${inspection.id}`} className="text-[13px] font-bold text-brand-500">
                  Open
                </Link>
              </span>
            </div>
          ))}
          {landlord ? (
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run(
                    () => api.post(`/leases/${leaseId}/inspections`, { kind: 'incoming', scheduledFor: today() }),
                    'Move-in inspection created',
                  )
                }
              >
                Book move-in
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run(
                    () => api.post(`/leases/${leaseId}/inspections`, { kind: 'outgoing', scheduledFor: data.endDate }),
                    'Move-out inspection created',
                  )
                }
              >
                Book move-out
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {landlord ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setShowPayment(true)}>Record a payment</Button>
          {!data.renewal && !data.termination ? (
            <Button variant="outline" onClick={() => setShowRenewal(true)}>Offer a renewal</Button>
          ) : null}
          {!data.termination ? (
            <Button variant="outline" onClick={() => setShowNotice(true)}>Serve notice</Button>
          ) : null}
          {data.termination ? (
            <Link
              to={`/terminations/${data.termination.id}`}
              className="rounded-sm bg-brand-500 px-4 py-2.5 text-[14px] font-bold text-ink-inverse"
            >
              Settle the deposit
            </Link>
          ) : null}
        </div>
      ) : null}

      <Modal open={showPayment} onOpenChange={(next) => setShowPayment(next)} title="Record a payment">
        <div className="space-y-3">
          <Select
            value={payment.invoiceId}
            onChange={(e) => setPayment({ ...payment, invoiceId: e.target.value })}
            options={[
              { value: '', label: 'Against the deposit' },
              ...open.map((invoice) => ({
                value: invoice.id,
                label: `${invoice.period} · outstanding ${((invoice.totalCents - invoice.paidCents) / 100).toFixed(2)}`,
              })),
            ]}
          />
          <CurrencyInput
            cents={payment.amountCents}
            onCentsChange={(next) => setPayment({ ...payment, amountCents: next ?? 0 })}
          />
          <Input
            placeholder="Bank reference"
            value={payment.reference}
            onChange={(e) => setPayment({ ...payment, reference: e.target.value })}
          />
          <p className="text-xs text-ink-muted">
            Overpaying an invoice is rejected on purpose. Split the excess onto the next one so
            every rand sits against exactly one invoice.
          </p>
          <Button
            block
            disabled={payment.amountCents <= 0}
            onClick={() =>
              run(async () => {
                await api.post(`/leases/${leaseId}/payments`, {
                  target: payment.invoiceId ? 'invoice' : 'deposit',
                  invoiceId: payment.invoiceId || undefined,
                  amountCents: payment.amountCents,
                  method: 'eft',
                  reference: payment.reference || undefined,
                  receivedOn: today(),
                });
                setShowPayment(false);
              }, 'Payment recorded')
            }
          >
            Save
          </Button>
        </div>
      </Modal>

      <Modal open={showRenewal} onOpenChange={(next) => setShowRenewal(next)} title="Offer a renewal">
        <div className="space-y-3">
          <p className="text-[13.5px] text-ink-muted">
            Twelve months from the day after this lease ends, at the agreed escalation. The
            deposit tops up to match the new rent rather than being refunded and recollected.
          </p>
          <Button
            block
            onClick={() =>
              run(async () => {
                await api.post(`/leases/${leaseId}/renewal`, {});
                setShowRenewal(false);
              }, 'Renewal offered')
            }
          >
            Send the offer
          </Button>
        </div>
      </Modal>

      <Modal open={showNotice} onOpenChange={(next) => setShowNotice(next)} title="Serve notice">
        <div className="space-y-3">
          <Select
            value={notice.reason}
            onChange={(e) => setNotice({ ...notice, reason: e.target.value })}
            options={[
              { value: 'end_of_term', label: 'Running to the end of the term' },
              { value: 'early_tenant', label: 'Tenant cancelling early' },
              { value: 'breach_by_tenant', label: 'Breach by the tenant' },
              { value: 'mutual', label: 'Both parties agree' },
            ]}
          />
          <p className="text-xs text-ink-muted">
            Early cancellation carries 20 business days under the Consumer Protection Act. The
            earliest lawful date is worked out for you and cannot be brought forward.
          </p>
          <Button
            block
            onClick={() =>
              run(async () => {
                await api.post(`/leases/${leaseId}/termination`, {
                  initiatedBy: notice.reason === 'early_tenant' ? 'tenant' : 'landlord',
                  reason: notice.reason,
                  noticeGivenOn: today(),
                });
                setShowNotice(false);
              }, 'Notice served')
            }
          >
            Serve it
          </Button>
        </div>
      </Modal>
    </main>
  );
}
