import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Alert, Avatar, Badge, Button, Checkbox, CurrencyInput, Input, Modal, Select, Textarea, useToast,
} from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { ArrearsPanel } from '../components/arrears-panel';
import { ChargesPanel, type Charge } from '../components/charges-panel';
import { ConfirmNotice, needsTenantConfirmation } from '../components/confirm-notice';
import { Money } from '../components/money';
import { QueryState } from '../components/query-state';
import { addDays, localToday } from '../lib/dates';
import {
  addBusinessDays, businessDaysBetween, landlordEndOfTermServableFrom, LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS,
} from '../lib/business-days';
import { formatDate, status, formatInstant } from '../lib/format';
import { randomId } from '../lib/ids';
import { useOpenDocument } from '../lib/open-document';
import { putFile } from '../lib/photos';
import { invalidateMoneyCaches } from '../lib/money-caches';
import { PAGE } from '../lib/layout';
import { ActionLink, FactList, ROW, ROWS, SectionCard } from '../components/core-kit';

interface Lease {
  id: string; ref: string; status: string; unit: string; tenant: string; tenantEmail: string;
  startDate: string; endDate: string; monthlyRentCents: number; escalationPct: number;
  depositCents: number; hasDocument: boolean; pdfKey: string | null;
  source: 'online' | 'import'; tenantHasAccount: boolean; tenantInviteSentAt: string | null;
  charges: Charge[];
  viewer: { isLandlord: boolean; isTenant: boolean };
  inspections: { id: string; kind: string; status: string; scheduledFor: string; findings: number; flagged: number; reportKey: string | null }[];
  termination: {
    id: string; status: string; reason?: string; effectiveOn: string; noticeGivenOn: string; refundDueBy: string | null;
    deductions: number; statementKey: string | null; penaltyCents?: number;
    /** Who gave the notice; only they may withdraw it, either party for a mutual one. */
    initiatedBy?: 'tenant' | 'landlord' | 'mutual';
    /** Recorded by the landlord for the tenant and not yet confirmed by them. */
    awaitingTenant?: boolean;
    /** The landlord attached the tenant's written notice and vouched for it, so it stands
        without the tenant confirming in the app. */
    attested?: boolean;
    attestation?: { at: string; statement: string | null; evidenceKey: string | null } | null;
  } | null;
  renewal: { id: string; respondBy: string; newStartDate: string; newEndDate: string; newRentCents: number; depositTopUpCents: number } | null;
  renewedBy: { id: string; ref: string; status: string; startDate: string; signaturesOnFile: number } | null;
  signatures: { party: 'tenant' | 'landlord'; signedAt: string }[];
  invoices: { id: string; period: string; dueOn: string; totalCents: number; paidCents: number; status: string; pdfKey: string | null }[];
}

/**
 * What the server allows for a notice on this lease, so the form says it before the server
 * refuses it. A lease whose renewal is signed takes no notice; an accepted renewal not yet
 * signed is cancelled by the notice. One past its end date runs month to month and needs 20
 * business days; so does a landlord's end-of-term notice given with fewer than 40 business days
 * left (CPA s14(2)(c)), which may then run up to a month past the end date. Any other
 * one-sided notice ends by the end date at the latest, an agreed one at most a month after it.
 * A landlord's end-of-term notice more than 80 business days before the end date is too early.
 */
export function noticeRules(
  lease: Pick<Lease, 'status' | 'endDate' | 'renewedBy'>,
  reason: string,
  today: string,
  notice: { initiatedBy?: 'tenant' | 'landlord' | 'mutual'; givenOn?: string } = {},
) {
  const givenOn = notice.givenOn || today;
  const scheduledRenewal = lease.renewedBy?.status === 'scheduled';
  const renewalAccepted = scheduledRenewal && lease.renewedBy!.signaturesOnFile === 2;
  const renewalUnsigned = scheduledRenewal && !renewalAccepted;
  const monthToMonth = lease.endDate <= givenOn;
  const landlordLate =
    reason === 'end_of_term' &&
    notice.initiatedBy === 'landlord' &&
    !monthToMonth &&
    addBusinessDays(givenOn, 40) > lease.endDate;
  // As the server's latestEffectiveDate: a one-sided notice ends by the end date; an agreed one,
  // one on a run-out lease, or a late landlord's runs to 31 days past the later of the earliest
  // end date and the lease end.
  let latestEffectiveOn = lease.endDate;
  if (reason === 'mutual' || monthToMonth || landlordLate) {
    let earliest = lease.endDate;
    if (monthToMonth) earliest = reason === 'mutual' ? givenOn : addBusinessDays(givenOn, 20);
    else if (landlordLate) earliest = addBusinessDays(givenOn, 20);
    latestEffectiveOn = addDays(earliest > lease.endDate ? earliest : lease.endDate, 31);
  }
  // As the server (terminations-serve): a landlord's end-of-term notice is given no more than 80
  // business days before the end date. Earlier than that it is refused, so the form says from when.
  const tooEarly =
    reason === 'end_of_term' &&
    notice.initiatedBy === 'landlord' &&
    lease.endDate > givenOn &&
    businessDaysBetween(givenOn, lease.endDate) > LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS;
  return {
    tooEarly,
    servableFrom: tooEarly ? landlordEndOfTermServableFrom(lease.endDate) : null,
    canServe: lease.status === 'active' && !renewalAccepted,
    renewalAccepted,
    renewalUnsigned,
    monthToMonth,
    landlordLate,
    latestEffectiveOn,
  };
}

/** Whether this viewer may withdraw the notice: the party who gave it, either for a mutual one,
    before the lease ends. A tenant may still undo one they never confirmed. Mirrors the server. */
export function canWithdrawNotice(
  lease: Pick<Lease, 'status' | 'termination' | 'viewer'>,
  today: string,
): boolean {
  const termination = lease.termination;
  if (!termination || lease.status !== 'active') return false;
  if (termination.status === 'withdrawn' || termination.status === 'settled') return false;
  const party = lease.viewer.isLandlord ? 'landlord' : lease.viewer.isTenant ? 'tenant' : null;
  if (!party || !termination.initiatedBy) return false;
  const awaiting = Boolean(termination.awaitingTenant);
  // As on the server: a landlord may undo a tenant's notice they recorded until the tenant confirms it.
  const landlordUndoesOwnEntry = party === 'landlord' && awaiting;
  if (termination.initiatedBy !== 'mutual' && termination.initiatedBy !== party && !landlordUndoesOwnEntry) return false;
  // As on the server: a confirmed mutual notice binds both, so neither undoes it alone.
  if (termination.initiatedBy === 'mutual' && !awaiting) return false;
  return today < termination.effectiveOn || awaiting;
}

/** The invoices a payment can be recorded against. A void invoice is cancelled, and
    excluding only paid ones used to offer it. */
export function payableInvoices<T extends { status: string }>(invoices: T[]): T[] {
  return invoices.filter((invoice) => invoice.status === 'issued' || invoice.status === 'part_paid');
}

/** The earliest day a payment may be dated: a deposit is often paid a little before the lease starts. */
export const earliestReceivedOn = (startDate: string) => addDays(startDate, -60);

/**
 * When an inspection may be booked, as inspections-create allows. Move-in: any day, on a live
 * lease with no notice and no move-in inspection yet. Move-out: a day in the final three days of
 * the tenancy and not in the past; none once that window has gone, which on a lease past its
 * end date means until a notice sets a new last day.
 */
export function inspectionBooking(
  lease: Pick<Lease, 'status' | 'startDate' | 'endDate' | 'termination' | 'inspections'>,
  today: string,
) {
  const live = lease.status === 'out_for_signature' || lease.status === 'active';
  const noticed = Boolean(lease.termination && lease.termination.status !== 'withdrawn');
  const standing = (kind: string) => lease.inspections.filter((item) => item.kind === kind && item.status !== 'missed');
  const lastDay = lease.termination?.effectiveOn ?? lease.endDate;
  const opens = addDays(lastDay, -3);
  const from = opens > today ? opens : today;
  const exitDone = standing('outgoing').some(
    (item) => item.status === 'completed' && item.scheduledFor >= opens && item.scheduledFor <= lastDay,
  );
  return {
    incoming: {
      allowed: live && !noticed && standing('incoming').length === 0,
      suggested: lease.startDate > today ? lease.startDate : today,
    },
    outgoing: {
      allowed: live && lastDay >= today && !exitDone,
      /** Past its end date with no notice: there is no last day to book against yet. */
      needsNotice: live && !noticed && lastDay < today,
      from,
      to: lastDay,
      rebooks: standing('outgoing').length > 0,
    },
  };
}

/** One money entry on the lease's statement. A reversal is its own entry, pointing at what it undid. */
export interface StatementPayment {
  id: string; invoiceId: string | null; amountCents: number; method: string; reference: string | null;
  receivedOn: string; reversedBy?: string | null; reversesPaymentId?: string | null; reason?: string | null;
}

const METHOD_LABEL: Record<string, string> = {
  eft: 'EFT', cash: 'Cash', gateway: 'Card', deposit: 'From the deposit', refund: 'Refund at settlement', reversal: 'Reversal',
};
/** Entries the server will not reverse: a reversal itself, and what the deposit settlement wrote. */
export const reversible = (payment: StatementPayment) =>
  !payment.reversedBy && !payment.reversesPaymentId && !['reversal', 'deposit', 'refund'].includes(payment.method);

const EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
/** Some Android file managers hand over a PDF with no type at all. */
const evidenceType = (file: File) => file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
const evidenceProblem = (file: File | null): string | null => {
  if (!file) return null;
  if (!EVIDENCE_TYPES.includes(evidenceType(file))) return 'Use a photo (JPEG or PNG) or a PDF.';
  if (file.size > EVIDENCE_MAX_BYTES) return 'That file is over 10 MB. Use a smaller photo or scan.';
  return file.size === 0 ? 'That file is empty.' : null;
};
const STATEMENT_MIN = 10;

const KIND_LABEL: Record<string, string> = { incoming: 'Move-in', outgoing: 'Move-out' };
const LABEL = 'text-meta font-semibold text-ink';
const HINT = 'text-meta text-ink-muted';

export function LeaseDetail() {
  const { leaseId } = useParams();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const queryClient = useQueryClient();
  // receivedOn is the day the money arrived, not the day it is typed in: it decides which month
  // it counts in, whether rent was late, and when deposit interest starts.
  const [payment, setPayment] = useState({ amountCents: 0, reference: '', invoiceId: '', receivedOn: '', method: 'eft' });
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
  // The offer as the landlord wants it. An empty rent means "the current rent plus the escalation".
  const [renewal, setRenewal] = useState({ newRentCents: null as number | null, termMonths: '12', escalationPct: '', respondDays: '14' });
  // Serving notice starts the end of a tenancy, so it takes a deliberate second step.
  const [noticeConfirmed, setNoticeConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  // Which inspection is being booked, and for what day.
  const [booking, setBooking] = useState<{ kind: 'incoming' | 'outgoing'; date: string } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // The tenant's written notice, attached to a notice the landlord recorded for them.
  const [attesting, setAttesting] = useState(false);
  const [evidence, setEvidence] = useState<{ file: File | null; statement: string }>({ file: null, statement: '' });
  const [reversing, setReversing] = useState<StatementPayment | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [allPayments, setAllPayments] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<Lease>(`/leases/${leaseId}`),
  });

  // Payments already recorded, so a wrong one can be found and reversed. The same cache the
  // tenant's rent screen reads.
  const statement = useQuery({
    queryKey: ['statement', leaseId],
    queryFn: () => api.get<{ payments: StatementPayment[] }>(`/leases/${leaseId}/statement`),
    enabled: Boolean(data?.viewer.isLandlord),
    retry: false,
  });

  /** Sends the written notice to storage and returns its key. The size sent must be the file's own. */
  const uploadEvidence = async (file: File) => {
    const contentType = evidenceType(file);
    const { evidenceKey, uploadUrl } = await api.post<{ evidenceKey: string; uploadUrl: string }>(
      `/leases/${leaseId}/notice-evidence/presign`,
      { contentType, sizeBytes: file.size },
    );
    await putFile(uploadUrl, file, contentType);
    return evidenceKey;
  };

  const startPayment = (lease: Lease) => {
    setPaymentKey(randomId());
    // Rent, not the deposit, is what a quick entry usually is: start on the oldest open invoice.
    // With none open, nothing is chosen and Save waits for one.
    const oldest = [...payableInvoices(lease.invoices)].sort((a, b) => a.period.localeCompare(b.period))[0];
    setPayment({ amountCents: 0, reference: '', invoiceId: oldest?.id ?? '', receivedOn: localToday(), method: 'eft' });
    setShowPayment(true);
  };

  // "Record a payment" on the Overview lands here with ?pay=1: open the form once, then drop
  // the flag so a reload or the back button does not open it again.
  const wantsPayment = searchParams.get('pay') === '1';
  useEffect(() => {
    if (!data || !wantsPayment) return;
    setSearchParams({}, { replace: true });
    if (data.viewer.isLandlord && !['terminated', 'cancelled', 'scheduled'].includes(data.status)) startPayment(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, wantsPayment]);

  // Every action on this screen moves money or changes the lease's state, so one runs at a
  // time: the buttons are disabled until the request answers. A double tap on "Save" used to
  // record the payment twice.
  const run = async (fn: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.show({ title: message, tone: 'success' });
      // A payment can clear the arrears, or bring the next reminder forward, and it moves the
      // statement and both reports too; refetch() alone left those stale.
      void invalidateMoneyCaches(queryClient);
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
  const open = payableInvoices(data.invoices);
  const today = localToday();
  const openNotice = (reason: string) => {
    setEvidence({ file: null, statement: '' });
    setNotice({ reason, givenOn: today, effectiveOn: '', penaltyCents: 0 });
    setShowNotice(true);
  };
  const openPayment = () => startPayment(data);
  const openRenewal = () => {
    setRenewal({ newRentCents: null, termMonths: '12', escalationPct: String(data.escalationPct), respondDays: '14' });
    setShowRenewal(true);
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
  // Only a tenant's written notice may be backdated; the server dates the rest today.
  const backdatable = landlord && initiatedBy() === 'tenant';
  const noticeGivenOn = backdatable ? notice.givenOn : today;
  const rules = noticeRules(data, notice.reason, today, { initiatedBy: initiatedBy(), givenOn: noticeGivenOn });
  const withdrawable = canWithdrawNotice(data, today);
  // A signed renewal is the one case that is not re-offered: unsigned, a new offer replaces it.
  const renewalSigned = data.renewedBy?.status === 'scheduled' && data.renewedBy.signaturesOnFile === 2;
  const bookable = inspectionBooking(data, today);
  // A tenant's or an agreed notice that the landlord records rests on the landlord's word until
  // the tenant confirms it in the app, or the landlord attaches the written notice.
  const needsBacking = landlord && initiatedBy() !== 'landlord';
  // With no account the tenant cannot confirm, so the written notice is the only way to record it.
  const evidenceRequired = needsBacking && !data.tenantHasAccount;
  const evidenceBad = evidenceProblem(evidence.file);
  const statementShort = evidence.statement.trim().length < STATEMENT_MIN;
  const evidenceReady = Boolean(evidence.file) && !evidenceBad && !statementShort;
  // Both or neither, as the server asks.
  const evidenceHalf = needsBacking && !evidenceReady && (Boolean(evidence.file) || evidence.statement.trim().length > 0);
  const payments = [...(statement.data?.payments ?? [])]
    .filter((payment) => !payment.reversesPaymentId && payment.method !== 'reversal')
    .sort((a, b) => b.receivedOn.localeCompare(a.receivedOn));
  const reversalOf = new Map((statement.data?.payments ?? []).map((payment) => [payment.id, payment]));
  const periodOf = new Map(data.invoices.map((invoice) => [invoice.id, invoice.period]));
  const shownPayments = allPayments ? payments : payments.slice(0, 6);
  const canReverse = landlord && data.status !== 'terminated' && data.termination?.status !== 'settled';
  const earliestReceived = earliestReceivedOn(data.startDate);
  const receivedTooEarly = Boolean(payment.receivedOn) && payment.receivedOn < earliestReceived;
  const overdueCents = open
    .filter((invoice) => invoice.dueOn < today)
    .reduce((sum, invoice) => sum + invoice.totalCents - invoice.paidCents, 0);
  const noticed = data.termination && !['withdrawn', 'settled'].includes(data.termination.status) && data.status === 'active';
  const pill = noticed
    ? { tone: 'warning' as const, label: `Ends ${formatDate(data.termination!.effectiveOn)}` }
    : overdueCents > 0 && data.status === 'active'
      ? { tone: 'danger' as const, label: `Owes ${formatZar(overdueCents / 100)}` }
      : data.status === 'scheduled'
        ? { tone: 'info' as const, label: 'Starts ' + formatDate(data.startDate) }
        : status(data.status);
  const avatarTone = pill.tone === 'neutral' ? undefined : pill.tone;
  const liveForLandlord = landlord && !['terminated', 'cancelled', 'scheduled'].includes(data.status);
  // The server offers a renewal only on an active lease with no notice and no offer open.
  const canOfferRenewal = landlord && data.status === 'active' && !data.renewal && !data.termination && !renewalSigned;
  const canEnd = !data.termination && rules.canServe && (landlord || data.viewer.isTenant);
  const escalation = Number(renewal.escalationPct);
  const term = Number(renewal.termMonths);
  const respondDays = Number(renewal.respondDays);
  const renewalBad =
    renewal.escalationPct.trim() === '' || !(escalation >= 0 && escalation <= 50) ||
    !Number.isInteger(respondDays) || respondDays < 1 || respondDays > 90 ||
    (renewal.newRentCents !== null && renewal.newRentCents <= 0);
  const bookingBad =
    !booking || !/^\d{4}-\d{2}-\d{2}$/.test(booking.date) ||
    (booking.kind === 'outgoing' && (booking.date < bookable.outgoing.from || booking.date > bookable.outgoing.to));

  return (
    <main className={PAGE.wide}>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {landlord ? <Avatar name={data.tenant} size="lg" tone={avatarTone} /> : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">
                {landlord ? data.tenant : data.unit}
              </h1>
              <Badge tone={pill.tone}>{pill.label}</Badge>
            </div>
            <p className="mt-1 text-body text-ink-muted">
              {landlord ? `${data.unit} · ${data.ref}` : `${data.ref} · your lease`}
            </p>
          </div>
        </div>

        {liveForLandlord ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={openPayment}>Record a payment</Button>
            {canOfferRenewal ? <Button variant="outline" onClick={openRenewal}>Offer a renewal</Button> : null}
            {data.termination ? (
              <ActionLink to={`/terminations/${data.termination.id}`}>Settle the deposit</ActionLink>
            ) : null}
          </div>
        ) : null}

        {/* Settling ends the lease, which hid the only way back to the settlement and statement. */}
        {data.status === 'terminated' && data.termination ? (
          <div className="flex flex-wrap gap-2">
            {data.termination.statementKey ? (
              <Button variant="outline" onClick={() => openDocument(data.termination!.statementKey!)}>
                Deposit statement
              </Button>
            ) : null}
            {landlord ? <ActionLink to={`/terminations/${data.termination.id}`}>Deposit settlement</ActionLink> : null}
          </div>
        ) : null}
      </header>

      {data.status === 'scheduled' ? (
        <Alert
          tone={data.signatures.length === 2 ? 'success' : 'info'}
          title={data.signatures.length === 2 ? `Signed · starts ${formatDate(data.startDate)}` : 'Renewal waiting for signatures'}
          className="mb-6"
        >
          {data.signatures.length === 2 ? (
            'Both signatures are on file. This lease takes over from the current one on its start date.'
          ) : (
            <>
              <Link to={`/lease/${data.id}`} className="font-semibold underline underline-offset-4">
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
          className="mb-6"
        >
          {data.renewedBy.signaturesOnFile === 2 ? (
            <>
              Both of you have signed the new lease, so notice cannot be given on this one. Once the
              new lease starts on {formatDate(data.renewedBy.startDate)}, notice is given on that one.
            </>
          ) : (
            <>
              The renewal was accepted, but it only starts once you have both signed it.{' '}
              <Link to={`/lease/${data.renewedBy.id}`} className="font-semibold underline underline-offset-4">
                Sign the new lease
              </Link>
              . Until then notice can still be given on this lease, and giving it cancels the renewal.
            </>
          )}
        </Alert>
      ) : null}

      {data.status === 'out_for_signature' ? (
        <Alert tone="info" title="Out for signature" className="mb-6">
          <Link to={`/lease/${data.id}`} className="font-semibold underline underline-offset-4">
            Open the signing page
          </Link>{' '}
          to review the document and sign.
        </Alert>
      ) : null}

      {/* Phone: key facts, then the work, then the quick actions. Laptop: the work on the left, facts and actions down the right. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <SectionCard title="Key facts">
            <FactList
              facts={[
                { label: 'Rent', value: <><Money cents={data.monthlyRentCents} /> <span className="font-normal text-ink-muted">a month</span></> },
                { label: 'Deposit', value: <Money cents={data.depositCents} /> },
                { label: 'Escalation', value: `${data.escalationPct}% a year` },
                { label: 'Starts', value: formatDate(data.startDate) },
                { label: 'Ends', value: formatDate(data.endDate) },
                ...(landlord ? [{ label: 'Tenant', value: data.tenant }, { label: 'Email', value: (
                  <a href={`mailto:${data.tenantEmail}`} className="font-semibold text-brand-600 underline-offset-4 hover:underline">{data.tenantEmail}</a>
                ) }] : []),
              ]}
            />
            {data.source === 'import' && landlord ? (
              <div className="space-y-3 border-t border-line-soft px-5 py-4">
                <div>
                  <p className="text-body font-bold text-ink">Brought in from before Threshold</p>
                  <p className={HINT}>
                    The signed lease stays on paper.{' '}
                    {data.tenantHasAccount
                      ? `${data.tenant} uses the app.`
                      : data.tenantInviteSentAt
                        ? `${data.tenant} was invited to the app ${formatInstant(data.tenantInviteSentAt)} and has not joined yet.`
                        : `${data.tenant} is not using the app yet.`}
                  </p>
                </div>
                {!data.tenantHasAccount ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => run(() => api.post(`/leases/${leaseId}/tenant-invite`, {}), `Invitation sent to ${data.tenantEmail}`)}
                  >
                    {data.tenantInviteSentAt ? 'Send the invitation again' : 'Invite to the app'}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </SectionCard>
        </div>

        <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          {data.renewal ? (
            <SectionCard
              title="Renewal offered"
              action={<Badge tone="info">Answer by {formatDate(data.renewal.respondBy)}</Badge>}
            >
              <div className="space-y-3 px-5 py-4">
                <p className="text-body text-ink">
                  {formatDate(data.renewal.newStartDate)} to {formatDate(data.renewal.newEndDate)} at{' '}
                  <Money cents={data.renewal.newRentCents} /> a month.
                </p>
                {data.renewal.depositTopUpCents > 0 ? (
                  <p className={HINT}>
                    Deposit top-up of <Money cents={data.renewal.depositTopUpCents} />. Your existing
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
                  <p className={HINT}>Waiting on the tenant.</p>
                )}
              </div>
            </SectionCard>
          ) : null}

          {data.termination ? (
            <Alert tone="warning" title={`Lease ends ${formatDate(data.termination.effectiveOn)}`}>
              Notice served {formatDate(data.termination.noticeGivenOn)}. The exit inspection must happen in the
              final three days, with both of you there. Skip it and the law treats the place as
              undamaged, so nothing can be deducted.
              {data.termination.refundDueBy ? ` Refund due by ${formatDate(data.termination.refundDueBy)}.` : ''}
              {landlord && data.termination.awaitingTenant ? (
                // Settling waits on this, so the landlord should see why.
                <p className="mt-2">Waiting for {data.tenant} to confirm it in the app. The deposit cannot be settled until then.</p>
              ) : data.termination.attested ? null : landlord && (data.termination.initiatedBy === 'mutual' || data.termination.initiatedBy === 'tenant') ? (
                // A tenant's notice is theirs whether they gave it in the app or confirmed the one
                // the landlord recorded: either way nothing more is needed from them.
                <p className="mt-2">{data.tenant} confirmed it.</p>
              ) : null}
              {landlord && data.termination.awaitingTenant && !data.termination.attested ? (
                <div className="mt-3 space-y-2">
                  <p>If {data.tenant} gave you notice on paper or by email, attach it and the notice stands without them confirming.</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => { setEvidence({ file: null, statement: '' }); setAttesting(true); }}
                  >
                    Tenant gave written notice: upload it
                  </Button>
                </div>
              ) : null}
              {data.termination.attested && data.termination.attestation ? (
                // Both parties see what the notice stands on, and can open the file.
                <div className="mt-3 space-y-2 rounded-sm bg-surface px-3.5 py-3">
                  <p className="font-semibold text-ink">
                    {landlord ? 'You attached' : 'Your landlord attached'} the written notice on{' '}
                    {formatInstant(data.termination.attestation.at)}
                  </p>
                  {data.termination.attestation.statement ? (
                    <p className="text-ink-muted">
                      {landlord ? 'Your statement' : 'Their statement'}: “{data.termination.attestation.statement}”
                    </p>
                  ) : null}
                  <p className="text-ink-muted">
                    {landlord
                      ? 'The notice stands on this, so the tenant does not need to confirm it.'
                      : 'The notice stands on this. If it is not the notice you gave, tell your landlord in writing straight away.'}
                  </p>
                  {data.termination.attestation.evidenceKey ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openDocument(data.termination!.attestation!.evidenceKey!)}
                    >
                      Open the written notice
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {needsTenantConfirmation(data.viewer, data.termination) ? (
                // Until the tenant confirms, the deposit cannot be settled.
                <div className="mt-3 space-y-2">
                  <p>Your landlord recorded this notice for you. Confirm it if it is what you agreed to.</p>
                  <ConfirmNotice leaseId={data.id} termination={data.termination} />
                </div>
              ) : null}
              {withdrawable ? (
                <div className="mt-3">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmWithdraw(true)}>
                    Withdraw the notice
                  </Button>
                </div>
              ) : null}
            </Alert>
          ) : null}

          <ArrearsPanel leaseId={data.id} landlord={landlord} className="" />

          <SectionCard title="Invoices" count={data.invoices.length > 0 ? data.invoices.length : undefined}>
            {data.invoices.length === 0 ? (
              <div className="px-5 py-4">
                <p className={HINT}>None yet. Next month's rent is invoiced on the 25th and shows here.</p>
              </div>
            ) : (
              <ul className={ROWS}>
                {data.invoices.map((invoice) => (
                  <li key={invoice.id} className={ROW}>
                    <div className="min-w-0">
                      <p className="text-body font-bold text-ink">{invoice.period}</p>
                      <p className={HINT}>Due {formatDate(invoice.dueOn)}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                      <Money cents={invoice.totalCents} className="text-body" />
                      <Badge tone={status(invoice.status).tone}>{status(invoice.status).label}</Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Open the ${invoice.period} invoice PDF`}
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
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {landlord && statement.data ? (
            <SectionCard title="Payments" count={payments.length > 0 ? payments.length : undefined}>
              {payments.length === 0 ? (
                <p className={`px-5 py-4 ${HINT}`}>
                  None recorded yet. A payment shows here once you record it or accept a tenant's slip, and a wrong
                  one can be reversed from here.
                </p>
              ) : (
                <ul className={ROWS}>
                  {shownPayments.map((payment) => {
                    const reversal = payment.reversedBy ? reversalOf.get(payment.reversedBy) : undefined;
                    const reversed = Boolean(payment.reversedBy);
                    const what = payment.invoiceId
                      ? periodOf.get(payment.invoiceId) ?? 'Rent'
                      : payment.method === 'refund' ? 'Deposit refund' : 'Deposit';
                    return (
                      <li key={payment.id} className={ROW}>
                        <div className="min-w-0">
                          <p className={`text-body font-bold ${reversed ? 'text-ink-muted line-through' : 'text-ink'}`}>
                            {formatDate(payment.receivedOn)} · {what}
                          </p>
                          <p className={HINT}>
                            {METHOD_LABEL[payment.method] ?? payment.method}
                            {payment.reference ? ` · ${payment.reference}` : ''}
                          </p>
                          {reversed ? (
                            <p className={HINT}>
                              Reversed{reversal ? ` ${formatDate(reversal.receivedOn)}` : ''}
                              {reversal?.reason ?? payment.reason ? `: ${reversal?.reason ?? payment.reason}` : '.'}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                          <Money cents={payment.amountCents} className={`text-body ${reversed ? 'text-ink-muted line-through' : ''}`} />
                          {reversed ? <Badge tone="neutral">Reversed</Badge> : null}
                          {canReverse && reversible(payment) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              aria-label={`Reverse the payment of ${formatZar(payment.amountCents / 100)} received ${formatDate(payment.receivedOn)}`}
                              onClick={() => { setReverseReason(''); setReversing(payment); }}
                            >
                              Reverse
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {payments.length > shownPayments.length ? (
                <div className="border-t border-line-soft px-5 py-3">
                  <Button size="sm" variant="link" onClick={() => setAllPayments(true)}>Show all {payments.length} payments</Button>
                </div>
              ) : null}
            </SectionCard>
          ) : null}

          <ChargesPanel
            leaseId={data.id}
            charges={data.charges}
            landlord={landlord}
            onChanged={() => {
              // A charge can land on an open invoice: home, reports and the statement move too.
              void invalidateMoneyCaches(queryClient);
              refetch();
            }}
          />

          <SectionCard
            title="Inspections"
            action={
              landlord && (bookable.incoming.allowed || bookable.outgoing.allowed) ? (
                <span className="flex flex-wrap gap-2">
                  {bookable.incoming.allowed ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setBooking({ kind: 'incoming', date: bookable.incoming.suggested })}
                    >
                      Book move-in
                    </Button>
                  ) : null}
                  {bookable.outgoing.allowed ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setBooking({ kind: 'outgoing', date: bookable.outgoing.to })}
                    >
                      Book move-out
                    </Button>
                  ) : null}
                </span>
              ) : null
            }
          >
            {data.inspections.length === 0 ? (
              <p className={`px-5 py-4 ${HINT}`}>
                {landlord
                  ? 'None booked. The move-in inspection is the record every deposit deduction is measured against.'
                  : 'None booked. Your landlord books these, and you are told the day.'}
              </p>
            ) : (
              <ul className={ROWS}>
                {data.inspections.map((inspection) => {
                  const kind = KIND_LABEL[inspection.kind] ?? 'Routine';
                  const name = `${kind.toLowerCase()} inspection of ${formatDate(inspection.scheduledFor)}`;
                  return (
                    <li key={inspection.id} className={ROW}>
                      <div className="min-w-0">
                        <p className="text-body font-bold text-ink">
                          {kind} · {formatDate(inspection.scheduledFor)}
                        </p>
                        <p className={HINT}>
                          {inspection.findings} items{inspection.flagged ? `, ${inspection.flagged} flagged` : ''}
                        </p>
                      </div>
                      <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                        <Badge tone={status(inspection.status).tone}>{status(inspection.status).label}</Badge>
                        {inspection.reportKey ? (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Open the report for the ${name}`}
                            onClick={() => openDocument(inspection.reportKey!)}
                          >
                            Report
                          </Button>
                        ) : null}
                        <ActionLink size="sm" to={`/inspections/${inspection.id}`} aria-label={`Open the ${name}`}>
                          Open
                        </ActionLink>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {landlord && bookable.outgoing.needsNotice ? (
              <p className={`border-t border-line-soft px-5 py-3 ${HINT}`}>
                This lease is past its end date, so there is no last day to book a move-out inspection against. Record
                a notice first; the inspection is then booked for the final three days.
              </p>
            ) : null}
          </SectionCard>
        </div>

        <aside className="min-w-0 space-y-6 lg:col-start-2 lg:row-start-2">
          {data.pdfKey || canEnd ? (
            <SectionCard title="Quick actions">
              <div className="space-y-3 px-5 py-4">
                {data.pdfKey ? (
                  <Button block variant="outline" onClick={() => openDocument(data.pdfKey!)}>
                    Open the lease agreement
                  </Button>
                ) : null}
                {canEnd ? (
                  <div className={data.pdfKey ? 'border-t border-line-soft pt-3' : ''}>
                    <p className="text-body font-bold text-ink">End this lease</p>
                    <p className={`mb-3 ${HINT}`}>
                      {landlord
                        ? 'Record notice when the lease is not being renewed, or when the tenant has cancelled in writing. It starts the end of the tenancy and tells the tenant.'
                        : 'Give notice if you want to leave. Your landlord is told straight away, and the earliest lawful end date is worked out for you.'}
                    </p>
                    <Button block variant="outline" onClick={() => openNotice(landlord ? 'end_of_term' : 'early_tenant')}>
                      {landlord ? 'Record a notice' : 'Give notice'}
                    </Button>
                  </div>
                ) : null}
              </div>
            </SectionCard>
          ) : null}
        </aside>
      </div>

      <Modal open={showPayment} onOpenChange={(next) => setShowPayment(next)} title="Record a payment">
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className={LABEL}>What this pays</span>
            <Select
              aria-label="What this pays"
              value={payment.invoiceId}
              onChange={(e) => setPayment({ ...payment, invoiceId: e.target.value })}
              options={[
                // A deliberate choice: an untouched default once credited rent to the deposit.
                ...(payment.invoiceId === '' ? [{ value: '', label: 'Choose what this pays' }] : []),
                { value: 'deposit', label: 'Against the deposit' },
                ...open.map((invoice) => ({
                  value: invoice.id,
                  label: `${invoice.period}, ${formatZar((invoice.totalCents - invoice.paidCents) / 100)} outstanding`,
                })),
              ]}
            />
          </label>
          <label className="block space-y-1.5">
            <span className={LABEL}>Amount</span>
            <CurrencyInput
              aria-label="Amount"
              cents={payment.amountCents}
              onCentsChange={(next) => setPayment({ ...payment, amountCents: next ?? 0 })}
            />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className={LABEL}>Received on</span>
              <Input
                type="date"
                aria-label="Received on"
                value={payment.receivedOn}
                // A deposit is often paid before the lease starts, so a little before it is allowed.
                min={earliestReceived}
                max={today}
                invalid={receivedTooEarly || payment.receivedOn > today}
                onChange={(e) => setPayment({ ...payment, receivedOn: e.target.value })}
              />
            </label>
            <label className="block space-y-1.5">
              <span className={LABEL}>How it was paid</span>
              <Select
                aria-label="How it was paid"
                value={payment.method}
                onChange={(e) => setPayment({ ...payment, method: e.target.value })}
                options={[
                  { value: 'eft', label: 'EFT' },
                  { value: 'cash', label: 'Cash' },
                ]}
              />
            </label>
          </div>
          {receivedTooEarly ? (
            // A slip of the year (2006 for 2026) used to save, and a payment cannot be corrected.
            <p role="alert" className="text-meta text-danger">
              That is before this lease. Pick a day from {formatDate(earliestReceived)} to today.
            </p>
          ) : null}
          <label className="block space-y-1.5">
            <span className={LABEL}>Bank reference (optional)</span>
            <Input
              aria-label="Bank reference"
              placeholder="As it shows on your statement"
              value={payment.reference}
              onChange={(e) => setPayment({ ...payment, reference: e.target.value })}
            />
          </label>
          <p className={HINT}>
            Overpaying an invoice is rejected on purpose. Split the excess onto the next one so
            every rand sits against exactly one invoice.
          </p>
          <Button
            block
            loading={busy}
            disabled={
              payment.amountCents <= 0 || payment.invoiceId === '' || !payment.receivedOn ||
              payment.receivedOn > today || receivedTooEarly
            }
            onClick={() =>
              run(async () => {
                const toDeposit = payment.invoiceId === 'deposit';
                await api.post(`/leases/${leaseId}/payments`, {
                  target: toDeposit ? 'deposit' : 'invoice',
                  invoiceId: toDeposit ? undefined : payment.invoiceId,
                  amountCents: payment.amountCents,
                  method: payment.method,
                  reference: payment.reference || undefined,
                  receivedOn: payment.receivedOn,
                  idempotencyKey: paymentKey,
                });
                setPaymentKey(randomId());
                setPayment({ amountCents: 0, reference: '', invoiceId: '', receivedOn: today, method: 'eft' });
                setShowPayment(false);
              }, 'Payment recorded')
            }
          >
            Save
          </Button>
        </div>
      </Modal>

      <Modal
        open={showRenewal}
        onOpenChange={(next) => setShowRenewal(next)}
        title="Offer a renewal"
        description={`The new lease starts the day after this one ends, on ${formatDate(addDays(data.endDate, 1))}.`}
      >
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className={LABEL}>New monthly rent (optional)</span>
            <CurrencyInput
              aria-label="New monthly rent"
              cents={renewal.newRentCents}
              onCentsChange={(next) => setRenewal({ ...renewal, newRentCents: next })}
            />
            <span className={`block ${HINT}`}>
              Leave it empty to take the rent in this lease's last month plus the escalation below.
            </span>
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="block space-y-1.5">
              <span className={LABEL}>Term</span>
              <Select
                aria-label="Term"
                value={renewal.termMonths}
                onChange={(e) => setRenewal({ ...renewal, termMonths: e.target.value })}
                options={[6, 12, 18, 24, 36].map((months) => ({ value: String(months), label: `${months} months` }))}
              />
            </label>
            <label className="block space-y-1.5">
              <span className={LABEL}>Escalation %</span>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                max={50}
                step={0.5}
                aria-label="Escalation percent a year"
                value={renewal.escalationPct}
                onChange={(e) => setRenewal({ ...renewal, escalationPct: e.target.value })}
              />
            </label>
            <label className="block space-y-1.5">
              <span className={LABEL}>Days to answer</span>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={90}
                step={1}
                aria-label="Days to answer"
                value={renewal.respondDays}
                onChange={(e) => setRenewal({ ...renewal, respondDays: e.target.value })}
              />
            </label>
          </div>
          {renewalBad ? (
            <p role="alert" className="text-meta text-danger">
              Escalation is 0 to 50 percent, and the tenant gets 1 to 90 days to answer.
            </p>
          ) : null}
          <p className={HINT}>
            The deposit tops up to match the new rent rather than being refunded and recollected. The tenant is told
            and accepts or declines in the app.
          </p>
          <Button
            block
            loading={busy}
            disabled={renewalBad}
            onClick={() =>
              run(async () => {
                await api.post(`/leases/${leaseId}/renewal`, {
                  termMonths: term,
                  escalationPct: escalation,
                  respondDays,
                  ...(renewal.newRentCents ? { newRentCents: renewal.newRentCents } : {}),
                });
                setShowRenewal(false);
              }, 'Renewal offered')
            }
          >
            Send the offer
          </Button>
        </div>
      </Modal>

      <Modal
        open={booking !== null}
        onOpenChange={(next) => { if (!next && !busy) setBooking(null); }}
        title={booking?.kind === 'outgoing' ? 'Book the move-out inspection' : 'Book the move-in inspection'}
        description={`${data.tenant} is told the day by email, so pick one you can both make.`}
        size="sm"
      >
        {booking ? (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className={LABEL}>Inspection day</span>
              <Input
                type="date"
                aria-label="Inspection day"
                value={booking.date}
                min={booking.kind === 'outgoing' ? bookable.outgoing.from : undefined}
                max={booking.kind === 'outgoing' ? bookable.outgoing.to : undefined}
                invalid={bookingBad}
                onChange={(e) => setBooking({ ...booking, date: e.target.value })}
              />
            </label>
            <p className={bookingBad && booking.kind === 'outgoing' ? 'text-meta text-danger' : HINT} role={bookingBad && booking.kind === 'outgoing' ? 'alert' : undefined}>
              {booking.kind === 'outgoing'
                ? `It must fall in the final three days of the tenancy: ${formatDate(bookable.outgoing.from)} to ${formatDate(bookable.outgoing.to)}.` +
                  (bookable.outgoing.rebooks ? ' The inspection already booked is replaced.' : '')
                : `The lease starts ${formatDate(data.startDate)}. Its defects list becomes part of the lease.`}
            </p>
            <Button
              block
              loading={busy}
              disabled={bookingBad}
              onClick={() =>
                run(async () => {
                  await api.post(`/leases/${leaseId}/inspections`, { kind: booking.kind, scheduledFor: booking.date });
                  setBooking(null);
                  // Rebooking marks the earlier one missed, and its page may be cached.
                  queryClient.invalidateQueries({ queryKey: ['inspection'] });
                }, booking.kind === 'outgoing' ? 'Move-out inspection created' : 'Move-in inspection created')
              }
            >
              Book the inspection
            </Button>
          </div>
        ) : null}
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
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className={LABEL}>Reason</span>
            <Select
              aria-label="Reason"
              value={notice.reason}
              // A date picked for a tenant's letter does not carry over to a notice dated today.
              onChange={(e) => setNotice({ ...notice, reason: e.target.value, givenOn: today })}
              options={noticeReasons}
            />
          </label>
          {rules.tooEarly && rules.servableFrom ? (
            <Alert tone="warning" title={`This notice can be recorded from ${formatDate(rules.servableFrom)}`}>
              An end-of-term notice is given no more than {LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS} business days before
              the lease ends on {formatDate(data.endDate)}. Choose another reason if the tenant has cancelled or you
              have both agreed.
            </Alert>
          ) : null}
          {backdatable ? (
            <label className="block space-y-1.5">
              <span className={LABEL}>Date the tenant’s notice reached you</span>
              <Input
                type="date"
                value={notice.givenOn}
                min={addDays(today, -30)}
                max={today}
                onChange={(e) => setNotice({ ...notice, givenOn: e.target.value })}
              />
            </label>
          ) : null}
          <label className="block space-y-1.5">
            <span className={LABEL}>
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
            <label className="block space-y-1.5">
              <span className={LABEL}>Cancellation penalty (optional)</span>
              <CurrencyInput
                cents={notice.penaltyCents}
                onCentsChange={(next) => setNotice({ ...notice, penaltyCents: next ?? 0 })}
              />
            </label>
          ) : null}
          {needsBacking ? (
            <fieldset className="space-y-3 rounded-sm border border-line px-4 py-3.5">
              <legend className={`px-1 ${LABEL}`}>
                The tenant’s written notice {evidenceRequired ? '' : '(optional)'}
              </legend>
              <p className={HINT}>
                {evidenceRequired
                  ? `${data.tenant} has no app account and cannot confirm this notice, so attach their letter or email to record it.`
                  : `Attach it and the notice stands at once. Without it, ${data.tenant} confirms the notice in the app before the deposit can be settled.`}
              </p>
              <EvidenceFields value={evidence} onChange={setEvidence} problem={evidenceBad} idPrefix="notice" />
            </fieldset>
          ) : null}
          <p className={HINT}>
            {rules.monthToMonth && notice.reason !== 'mutual'
              ? 'This lease has passed its end date and runs month to month, so 20 business days’ notice applies. '
              : ''}
            {rules.landlordLate
              ? 'Fewer than 40 business days are left on the lease, so it does not simply end on its end date: ' +
                'it runs month to month past it, and 20 business days’ notice applies. '
              : ''}
            {rules.renewalUnsigned
              ? 'The accepted renewal has not been signed, so giving notice cancels it. '
              : ''}
            {notice.reason === 'early_tenant'
              ? 'Cancelling early needs 20 business days’ notice under the Consumer Protection Act. ' +
                'The landlord may charge a reasonable cancellation penalty, deducted from the deposit at settlement.'
              : notice.reason === 'mutual'
                ? `An agreed end date can be any day from today up to ${formatDate(rules.latestEffectiveOn)}.`
                : `The earliest lawful end date is worked out for you and cannot be brought forward, nor set after ${formatDate(
                    rules.latestEffectiveOn,
                  )}.`}
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
            disabled={
              !noticeConfirmed || !notice.reason || (backdatable && !notice.givenOn) || rules.tooEarly ||
              (evidenceRequired && !evidenceReady) || evidenceHalf
            }
            onClick={() =>
              run(async () => {
                // The file goes up first: a notice recorded without it would wait on a tenant who cannot confirm.
                const evidenceKey = needsBacking && evidenceReady ? await uploadEvidence(evidence.file!) : undefined;
                const served = await api.post<{ effectiveOn: string }>(`/leases/${leaseId}/termination`, {
                  ...(evidenceKey ? { evidenceKey, statement: evidence.statement.trim() } : {}),
                  initiatedBy: initiatedBy(),
                  reason: notice.reason === 'tenant_end_of_term' ? 'end_of_term' : notice.reason,
                  // Only a tenant's written notice, recorded by the landlord, carries an earlier date.
                  noticeGivenOn,
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

      <Modal
        open={attesting}
        onOpenChange={(next) => { if (!busy) setAttesting(next); }}
        title="Attach the tenant’s written notice"
        description={`With it attached, the notice stands without ${data.tenant} confirming in the app. Both of you can open the file.`}
      >
        <div className="space-y-4">
          <EvidenceFields value={evidence} onChange={setEvidence} problem={evidenceBad} idPrefix="attest" />
          <p className={HINT}>
            Only attach a notice the tenant really gave. Your statement is kept with the lease and shown to the tenant.
          </p>
          <Button
            block
            loading={busy}
            disabled={!evidenceReady}
            onClick={() =>
              run(async () => {
                const evidenceKey = await uploadEvidence(evidence.file!);
                await api.post(`/terminations/${data.termination!.id}/attest`, { evidenceKey, statement: evidence.statement.trim() });
                setAttesting(false);
                // The notice is now in force: billing, the home list and the settlement all move.
                queryClient.invalidateQueries({ queryKey: ['settlement-summary', data.termination!.id] });
                queryClient.invalidateQueries({ queryKey: ['properties'] });
              }, 'Written notice attached')
            }
          >
            Attach and let the notice stand
          </Button>
        </div>
      </Modal>

      <Modal
        open={reversing !== null}
        onOpenChange={(next) => { if (!next && !busy) setReversing(null); }}
        title="Reverse this payment?"
        description="For a payment recorded on the wrong lease, or with the wrong amount or date. It stays on the record, struck through, and the invoice is open again."
        size="sm"
      >
        {reversing ? (
          <div className="space-y-4">
            <p className="text-body text-ink">
              <Money cents={reversing.amountCents} /> received {formatDate(reversing.receivedOn)}
              {reversing.invoiceId && periodOf.get(reversing.invoiceId) ? `, for ${periodOf.get(reversing.invoiceId)}` : ''}.
            </p>
            <label className="block space-y-1.5">
              <span className={LABEL}>Why it is being reversed</span>
              <Input
                aria-label="Why it is being reversed"
                maxLength={200}
                placeholder="For example, recorded on the wrong lease"
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
              />
            </label>
            <p className={HINT}>The tenant sees the reversal and your reason on their statement. Record the right payment afterwards.</p>
            <Button
              block
              variant="danger"
              loading={busy}
              disabled={reverseReason.trim().length < 3}
              onClick={() =>
                run(async () => {
                  await api.post(`/payments/${reversing.id}/reverse`, { reason: reverseReason.trim() });
                  setReversing(null);
                }, 'Payment reversed')
              }
            >
              Reverse the payment
            </Button>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={confirmWithdraw}
        onOpenChange={(next) => !busy && setConfirmWithdraw(next)}
        title="Withdraw the notice?"
        description={
          landlord
            ? `${data.tenant}'s lease carries on as if notice had never been given. The tenant is told.`
            : 'Your lease carries on as if notice had never been given. Your landlord is told.'
        }
      >
        <Button
          block
          loading={busy}
          onClick={() =>
            run(async () => {
              await api.post(`/terminations/${data.termination!.id}/withdraw`, {});
              setConfirmWithdraw(false);
              // Withdrawing re-rates invoices and lifts the end date everywhere it shows. The exit
              // inspection booked against it is marked missed, so its cached page is stale too.
              queryClient.invalidateQueries({ queryKey: ['leases'] });
              queryClient.invalidateQueries({ queryKey: ['comparison', data.termination!.id] });
              queryClient.invalidateQueries({ queryKey: ['settlement-preview', data.termination!.id] });
              queryClient.invalidateQueries({ queryKey: ['settlement-summary', data.termination!.id] });
              queryClient.invalidateQueries({ queryKey: ['inspection'] });
              queryClient.invalidateQueries({ queryKey: ['properties'] });
            }, 'Notice withdrawn')
          }
        >
          Withdraw the notice
        </Button>
      </Modal>
    </main>
  );
}

/** The file and the landlord's statement that back a tenant's written notice. */
function EvidenceFields({ value, onChange, problem, idPrefix }: {
  value: { file: File | null; statement: string };
  onChange: (next: { file: File | null; statement: string }) => void;
  problem: string | null;
  idPrefix: string;
}) {
  const short = value.statement.trim().length > 0 && value.statement.trim().length < STATEMENT_MIN;
  return (
    <>
      <label className="block space-y-1.5" htmlFor={`${idPrefix}-evidence-file`}>
        <span className={LABEL}>Letter, email or photo of the notice</span>
        <input
          id={`${idPrefix}-evidence-file`}
          type="file"
          accept="image/jpeg,image/png,application/pdf,.pdf"
          className="block w-full rounded-sm border border-neutral-300 bg-surface text-meta text-ink file:mr-3 file:h-11 file:border-0 file:bg-brand-50 file:px-4 file:font-semibold file:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]"
          onChange={(event) => onChange({ ...value, file: event.target.files?.[0] ?? null })}
        />
      </label>
      {problem ? <p role="alert" className="text-meta text-danger">{problem}</p> : null}
      <label className="block space-y-1.5" htmlFor={`${idPrefix}-evidence-statement`}>
        <span className={LABEL}>How and when you received it</span>
        <Textarea
          id={`${idPrefix}-evidence-statement`}
          maxLength={1000}
          placeholder="For example: Thandi emailed me this notice on 3 November."
          value={value.statement}
          invalid={short}
          onChange={(event) => onChange({ ...value, statement: event.target.value })}
        />
      </label>
      {short ? <p className="text-meta text-danger">Say a little more: at least {STATEMENT_MIN} characters.</p> : null}
    </>
  );
}
