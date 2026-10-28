import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, Checkbox, CurrencyInput, Input, Modal, PageHeader, Select, useToast,
} from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { ArrearsPanel } from '../components/arrears-panel';
import { ChargesPanel, type Charge } from '../components/charges-panel';
import { Ledger } from '../components/money';
import { QueryState } from '../components/query-state';
import { addDays, localToday } from '../lib/dates';
import { formatDate, status } from '../lib/format';
import { randomId } from '../lib/ids';
import { useOpenDocument } from '../lib/open-document';

interface Lease {
  id: string; ref: string; status: string; unit: string; tenant: string; tenantEmail: string;
  startDate: string; endDate: string; monthlyRentCents: number; escalationPct: number;
  depositCents: number; hasDocument: boolean; pdfKey: string | null;
  source: 'online' | 'import'; tenantHasAccount: boolean; tenantInviteSentAt: string | null;
  charges: Charge[];
  viewer: { isLandlord: boolean; isTenant: boolean };
  inspections: { id: string; kind: string; status: string; scheduledFor: string; findings: number; flagged: number; reportKey: string | null }[];
  termination: { id: string; status: string; effectiveOn: string; noticeGivenOn: string; refundDueBy: string | null; deductions: number; statementKey: string | null } | null;
  renewal: { id: string; respondBy: string; newStartDate: string; newEndDate: string; newRentCents: number; depositTopUpCents: number } | null;
  renewedBy: { id: string; ref: string; status: string; startDate: string; signaturesOnFile: number } | null;
  signatures: { party: 'tenant' | 'landlord'; signedAt: string }[];
  invoices: { id: string; period: string; dueOn: string; totalCents: number; paidCents: number; status: string; pdfKey: string | null }[];
}

/**
 * What the server allows for a notice on this lease, so the form says it before the server
 * refuses it. A lease with an accepted renewal takes no notice; one past its end date runs
 * month to month and needs 20 business days; a one-sided notice ends by the end date at the
 * latest, an agreed or month-to-month one at most a month after it.
 */
export function noticeRules(
  lease: Pick<Lease, 'status' | 'endDate' | 'renewedBy'>,
  reason: string,
  today: string,
) {
  const renewalAccepted = lease.renewedBy?.status === 'scheduled';
  const monthToMonth = lease.endDate <= today;
  const latestEffectiveOn = reason === 'mutual' || monthToMonth ? undefined : lease.endDate;
  return {
    canServe: lease.status === 'active' && !renewalAccepted,
    renewalAccepted,
    monthToMonth,
    latestEffectiveOn,
  };
}

export function LeaseDetail() {
  const { leaseId } = useParams();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const queryClient = useQueryClient();
  const [payment, setPayment] = useState({ amountCents: 0, reference: '', invoiceId: '' });
  // One key per attempt at recording a payment: a double tap or a retry after a dropped
  // connection sends the same key, and the server records the money once.
  const [paymentKey, setPaymentKey] = useState(() => randomId());
  const [showPayment, setShowPayment] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  // The landlord records a notice (theirs, a mutual one, or a tenant's given in writing); the
  // tenant serves their own. Each sees only the reasons that are theirs to give.
  const [notice, setNotice] = useState({ reason: '', givenOn: '', effectiveOn: '', penaltyCents: 0 });
  const navigate = useNavigate();
  const [showRenewal, setShowRenewal] = useState(false);
  // Serving notice starts the end of a tenancy, so it takes a deliberate second step.
  const [noticeConfirmed, setNoticeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<Lease>(`/leases/${leaseId}`),
  });

  // Every action on this screen moves money or changes the lease's state, so one runs at a
  // time: the buttons are disabled until the request answers. A double tap on "Save" used to
  // record the payment twice.
  const run = async (fn: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.show({ title: message, tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['leases'] });
      // A payment can clear the arrears, or bring the next reminder forward.
      queryClient.invalidateQueries({ queryKey: ['arrears', leaseId] });
      refetch();
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="This lease" />;
  }
  const landlord = data.viewer.isLandlord;
  const open = data.invoices.filter((i) => i.status !== 'paid');
  const today = localToday();
  const openNotice = (reason: string) => {
    setNotice({ reason, givenOn: today, effectiveOn: '', penaltyCents: 0 });
    setShowNotice(true);
  };
  const noticeReasons = landlord
    ? [
        { value: 'end_of_term', label: 'Landlord: ending at the end of the term' },
        { value: 'breach_by_tenant', label: 'Landlord: breach by the tenant' },
        { value: 'early_tenant', label: 'Tenant cancelled early, in writing' },
        { value: 'tenant_end_of_term', label: 'Tenant is leaving at the end of the term, in writing' },
        { value: 'mutual', label: 'Both parties agree' },
      ]
    : [
        { value: 'early_tenant', label: 'I am leaving before the lease ends' },
        { value: 'end_of_term', label: 'I am leaving when the lease ends' },
        { value: 'breach_by_landlord', label: 'The landlord has breached the lease' },
      ];
  // Who the notice is from, by the reason chosen and who is recording it.
  const initiatedBy = (): 'tenant' | 'landlord' | 'mutual' => {
    if (!landlord) return 'tenant';
    if (notice.reason === 'mutual') return 'mutual';
    return notice.reason === 'early_tenant' || notice.reason === 'tenant_end_of_term' ? 'tenant' : 'landlord';
  };
  const rules = noticeRules(data, notice.reason, today);

  return (
    <main className="mx-auto max-w-3xl px-5 py-6">
      <PageHeader title={data.unit} description={`${data.ref} · ${data.tenant}`} />

      {landlord && !['terminated', 'cancelled', 'scheduled'].includes(data.status) ? (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setPaymentKey(randomId());
              setShowPayment(true);
            }}
          >
            Record a payment
          </Button>
          {!data.renewal && !data.termination ? (
            <Button variant="outline" onClick={() => setShowRenewal(true)}>Offer a renewal</Button>
          ) : null}
          {data.termination ? (
            <Link
              to={`/terminations/${data.termination.id}`}
              className="rounded-sm border border-line bg-surface px-4 py-2 text-[14px] font-medium text-ink"
            >
              Settle the deposit
            </Link>
          ) : null}
        </div>
      ) : null}

      {data.status === 'scheduled' ? (
        <Alert
          tone={data.signatures.length === 2 ? 'success' : 'info'}
          title={data.signatures.length === 2 ? `Signed · starts ${formatDate(data.startDate)}` : 'Renewal waiting for signatures'}
          className="mb-4"
        >
          {data.signatures.length === 2 ? (
            'Both signatures are on file. This lease takes over from the current one on its start date.'
          ) : (
            <>
              <Link to={`/lease/${data.id}`} className="font-bold text-brand-500">
                Open the signing page
              </Link>
              . It starts on {formatDate(data.startDate)} once you have both signed; until then the current lease
              carries on month to month.
            </>
          )}
        </Alert>
      ) : null}

      {data.renewedBy && data.renewedBy.status === 'scheduled' ? (
        <Alert
          tone={data.renewedBy.signaturesOnFile === 2 ? 'success' : 'warning'}
          title={
            data.renewedBy.signaturesOnFile === 2
              ? `Renewed · ${data.renewedBy.ref} starts ${formatDate(data.renewedBy.startDate)}`
              : `Renewal ${data.renewedBy.ref} needs signing`
          }
          className="mb-4"
        >
          {data.renewedBy.signaturesOnFile === 2 ? (
            'Both of you have signed the new lease.'
          ) : (
            <>
              The renewal was accepted, but it only starts once you have both signed it.{' '}
              <Link to={`/lease/${data.renewedBy.id}`} className="font-bold text-brand-500">
                Sign the new lease
              </Link>
            </>
          )}{' '}
          Because the renewal was accepted, notice cannot be given on this lease. Once the new
          lease starts on {formatDate(data.renewedBy.startDate)}, notice is given on that one.
        </Alert>
      ) : null}

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
            ['Escalation', <span key="e" className="font-display text-[20px] font-medium">{data.escalationPct}%</span>],
            ['Ends', <span key="x" className="text-[15px] font-semibold">{formatDate(data.endDate)}</span>],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <p className="label">{label}</p>
              {value}
            </div>
          ))}
        </CardBody>
      </Card>

      {data.source === 'import' && landlord ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-4">
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-ink">Brought in from before Threshold</p>
            <p className="text-[13px] text-ink-muted">
              The signed lease stays on paper.{' '}
              {data.tenantHasAccount
                ? `${data.tenant} uses the app.`
                : data.tenantInviteSentAt
                  ? `${data.tenant} was invited to the app ${formatDate(data.tenantInviteSentAt.slice(0, 10))} and has not joined yet.`
                  : `${data.tenant} is not using the app yet.`}
            </p>
          </div>
          {!data.tenantHasAccount ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => api.post(`/leases/${leaseId}/tenant-invite`, {}), `Invitation sent to ${data.tenantEmail}`)}
            >
              {data.tenantInviteSentAt ? 'Send the invitation again' : 'Invite to the app'}
            </Button>
          ) : null}
        </div>
      ) : null}

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
            <p className="label text-brand-600">
              Renewal offered · answer by {formatDate(data.renewal.respondBy)}
            </p>
            <p className="text-[15px]">
              {formatDate(data.renewal.newStartDate)} to {formatDate(data.renewal.newEndDate)} at{' '}
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
                  loading={busy}
                  onClick={() =>
                    run(
                      async () => {
                        const accepted = await api.post<{ newLeaseId: string | null; documentReady: boolean }>(
                          `/renewals/${data.renewal!.id}/decision`,
                          { decision: 'accept' },
                        );
                        // Accepting is half of it: the new lease is signed next, here and now.
                        if (accepted.newLeaseId && accepted.documentReady) navigate(`/lease/${accepted.newLeaseId}`);
                      },
                      'Renewal accepted. Sign the new lease to finish.',
                    )
                  }
                >
                  Accept
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
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
        <Alert tone="warning" title={`Lease ends ${formatDate(data.termination.effectiveOn)}`} className="mb-4">
          Notice served {formatDate(data.termination.noticeGivenOn)}. The exit inspection must happen in the
          final three days, with both of you there. Skip it and the law treats the place as
          undamaged, so nothing can be deducted.
          {data.termination.refundDueBy ? ` Refund due by ${formatDate(data.termination.refundDueBy)}.` : ''}
        </Alert>
      ) : null}

      <ArrearsPanel leaseId={data.id} landlord={landlord} />

      <p className="label mb-2">Invoices</p>
      <Card className="mb-4">
        <CardBody className="space-y-2">
          {data.invoices.length === 0 ? (
            <p className="text-[13.5px] text-ink-muted">
              None yet. The run issues next month's rent on the 25th.
            </p>
          ) : null}
          {data.invoices.map((invoice) => (
            <div key={invoice.id} className="flex items-center justify-between gap-3 border-b border-line-soft pb-2 last:border-0">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold">{invoice.period}</p>
                <p className="text-xs text-ink-muted">Due {formatDate(invoice.dueOn)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Ledger cents={invoice.totalCents} className="text-[15px]" />
                <Badge tone={status(invoice.status).tone}>{status(invoice.status).label}</Badge>
                <button
                  type="button"
                  className="text-[13px] font-bold text-brand-500 disabled:opacity-40"
                  disabled={busy}
                  onClick={() =>
                    openDocument(
                      invoice.pdfKey ??
                        (async () => {
                          const rendered = await api.post<{ key: string }>(`/invoices/${invoice.id}/render`, {});
                          refetch();
                          return rendered.key;
                        }),
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

      <ChargesPanel
        leaseId={data.id}
        charges={data.charges}
        landlord={landlord}
        onChanged={() => {
          refetch();
          queryClient.invalidateQueries({ queryKey: ['arrears', leaseId] });
        }}
      />

      <p className="label mb-2">Inspections</p>
      <Card className="mb-4">
        <CardBody className="space-y-2">
          {data.inspections.length === 0 ? (
            <p className="text-[13.5px] text-ink-muted">None booked.</p>
          ) : null}
          {data.inspections.map((inspection) => (
            <div key={inspection.id} className="flex items-center justify-between">
              <div>
                <p className="text-[14px] font-semibold">
                  {inspection.kind === 'incoming' ? 'Move-in' : inspection.kind === 'outgoing' ? 'Move-out' : 'Routine'} ·{' '}
                  {formatDate(inspection.scheduledFor)}
                </p>
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
                disabled={busy}
                onClick={() =>
                  run(
                    () => api.post(`/leases/${leaseId}/inspections`, { kind: 'incoming', scheduledFor: localToday() }),
                    'Move-in inspection created',
                  )
                }
              >
                Book move-in
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      api.post(`/leases/${leaseId}/inspections`, {
                        kind: 'outgoing',
                        // The window closes on the day the tenancy actually ends.
                        scheduledFor: data.termination?.effectiveOn ?? data.endDate,
                      }),
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

      {!data.termination && rules.canServe && (landlord || data.viewer.isTenant) ? (
        <section className="mt-8 rounded-md border border-line p-4">
          <p className="text-[14px] font-semibold text-ink">End this lease</p>
          <p className="mb-3 text-[13px] text-ink-muted">
            {landlord
              ? 'Record notice when the lease is not being renewed, or when the tenant has cancelled in writing. It starts the end of the tenancy and tells the tenant.'
              : 'Give notice if you want to leave. Your landlord is told straight away, and the earliest lawful end date is worked out for you.'}
          </p>
          <Button variant="outline" onClick={() => openNotice(landlord ? 'end_of_term' : 'early_tenant')}>
            {landlord ? 'Record a notice' : 'Give notice'}
          </Button>
        </section>
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
                label: `${invoice.period}, ${formatZar((invoice.totalCents - invoice.paidCents) / 100)} outstanding`,
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
            loading={busy}
            disabled={payment.amountCents <= 0}
            onClick={() =>
              run(async () => {
                await api.post(`/leases/${leaseId}/payments`, {
                  target: payment.invoiceId ? 'invoice' : 'deposit',
                  invoiceId: payment.invoiceId || undefined,
                  amountCents: payment.amountCents,
                  method: 'eft',
                  reference: payment.reference || undefined,
                  receivedOn: localToday(),
                  idempotencyKey: paymentKey,
                });
                setPaymentKey(randomId());
                setPayment({ amountCents: 0, reference: '', invoiceId: '' });
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
            loading={busy}
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

      <Modal
        open={showNotice}
        onOpenChange={(next) => {
          setShowNotice(next);
          if (!next) setNoticeConfirmed(false);
        }}
        title={landlord ? 'Record a notice' : 'Give notice'}
        description={
          landlord
            ? `This ends ${data.tenant}'s lease of ${data.unit}. The tenant is told straight away.`
            : `This ends your lease of ${data.unit}. Your landlord is told straight away.`
        }
      >
        <div className="space-y-3">
          <Select
            value={notice.reason}
            onChange={(e) => setNotice({ ...notice, reason: e.target.value })}
            options={noticeReasons}
          />
          {landlord ? (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-ink-muted">
                {initiatedBy() === 'tenant' ? 'Date the tenant’s notice reached you' : 'Date the notice was given'}
              </span>
              <Input
                type="date"
                value={notice.givenOn}
                min={addDays(today, -30)}
                max={today}
                onChange={(e) => setNotice({ ...notice, givenOn: e.target.value })}
              />
            </label>
          ) : null}
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-ink-muted">
              Last day, if later than the earliest allowed (optional)
            </span>
            <Input
              type="date"
              value={notice.effectiveOn}
              min={today}
              max={rules.latestEffectiveOn}
              onChange={(e) => setNotice({ ...notice, effectiveOn: e.target.value })}
            />
          </label>
          {landlord && notice.reason === 'early_tenant' ? (
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-ink-muted">Cancellation penalty (optional)</span>
              <CurrencyInput
                cents={notice.penaltyCents}
                onCentsChange={(next) => setNotice({ ...notice, penaltyCents: next ?? 0 })}
              />
            </label>
          ) : null}
          <p className="text-xs text-ink-muted">
            {rules.monthToMonth && notice.reason !== 'mutual'
              ? 'This lease has passed its end date and runs month to month, so 20 business days’ notice applies. '
              : ''}
            {notice.reason === 'early_tenant'
              ? 'Cancelling early needs 20 business days’ notice under the Consumer Protection Act. ' +
                'The landlord may charge a reasonable cancellation penalty, deducted from the deposit at settlement.'
              : notice.reason === 'mutual'
                ? 'An agreed end date can be any day from today, up to a month after the lease ends.'
                : `The earliest lawful end date is worked out for you and cannot be brought forward${
                    rules.latestEffectiveOn ? `, nor set after ${rules.latestEffectiveOn}` : ''
                  }.`}
            {landlord ? ' A tenant’s notice must be in writing; keep the letter or email.' : ''}
          </p>
          <Checkbox
            id="notice-confirm"
            checked={noticeConfirmed}
            onChange={(event) => setNoticeConfirmed(event.target.checked)}
            label="I understand this starts the end of the tenancy"
          />
          <Button
            block
            variant="danger"
            loading={busy}
            disabled={!noticeConfirmed || !notice.reason || (landlord && !notice.givenOn)}
            onClick={() =>
              run(async () => {
                const served = await api.post<{ effectiveOn: string }>(`/leases/${leaseId}/termination`, {
                  initiatedBy: initiatedBy(),
                  reason: notice.reason === 'tenant_end_of_term' ? 'end_of_term' : notice.reason,
                  // The server dates a tenant's own notice today regardless.
                  noticeGivenOn: landlord ? notice.givenOn : today,
                  effectiveOn: notice.effectiveOn || undefined,
                  penaltyCents: landlord && notice.reason === 'early_tenant' ? notice.penaltyCents : undefined,
                });
                setShowNotice(false);
                setNoticeConfirmed(false);
                toast.show({ title: `The lease ends ${formatDate(served.effectiveOn)}`, tone: 'info' });
              }, landlord ? 'Notice recorded' : 'Notice given')
            }
          >
            {landlord ? 'Record it' : 'Give notice'}
          </Button>
        </div>
      </Modal>
    </main>
  );
}
