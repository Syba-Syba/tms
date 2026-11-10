import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  CurrencyInput,
  Drawer,
  EmptyState,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '@hlonie/toolbox/ui';
import { api, type ApplicationSummary, humanError } from '../api/client';
import { formatDate, formatInstant } from '../lib/format';
import { parsePercent } from '../lib/percent';
import { QueryError } from '../components/query-state';
import { createAndRender } from '../lib/uploads';
import { CreditCheckPanel } from '../components/credit-check';
import { PAGE } from '../lib/layout';
import { Money } from '../components/money';
import { ListsLinkButton, ListsTabs, listsButtonClass } from '../components/lists-kit';

const bandTone = { comfortable: 'success', tight: 'warning', over: 'danger' } as const;
/** What the percentage means, in words, under the pill. */
const bandHint = {
  comfortable: 'Comfortable: under a third of income',
  tight: 'Tight: about a third of income',
  over: 'High: more than the income carries easily',
} as const;
const riskHint = (item: ApplicationSummary) =>
  item.affordability.ratio === null || !Number.isFinite(item.affordability.ratio)
    ? 'Ask for payslips before you decide'
    : bandHint[item.affordability.band];

type QueueStatus = 'submitted' | 'approved' | 'declined';
const EMPTY: Record<QueueStatus, { title: string; description: string }> = {
  submitted: {
    title: 'No applications waiting',
    description: 'When someone applies for a vacant unit they show here with their income, documents and move-in date. Send a unit\'s apply link from Properties to get the first one.',
  },
  approved: {
    title: 'Nobody approved yet',
    description: 'Approved applicants show here until their lease is generated and signed.',
  },
  declined: {
    title: 'No declined applications',
    description: 'Applications you decline are kept here with the reason you gave.',
  },
};
/** Any whole number of months the server takes, with the usual terms said in years. */
const TERM_OPTIONS = Array.from({ length: 24 }, (_, index) => {
  const months = index + 1;
  return { value: String(months), label: months === 12 ? '12 months (1 year)' : months === 24 ? '24 months (2 years)' : `${months} month${months === 1 ? '' : 's'}` };
});

/** Rent as a share of income. With no income declared there is no share: 0% read as the best. */
export function incomeShare(ratio: number | null, suffix = ''): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'No income declared';
  return `${Math.round(ratio * 100)}%${suffix}`;
}

interface ApplicationDocument {
  id: string;
  kind: string;
  sizeBytes: number;
  uploadedAt: string;
  viewUrl: string;
}

const KIND_LABEL: Record<string, string> = {
  id_copy: 'ID copy',
  payslip: 'Payslip',
  bank_statement: 'Bank statement',
  proof_of_address: 'Proof of address',
  other: 'Other',
  credit_report: 'Credit report',
};

interface PortfolioUnit {
  code: string;
  status: string;
  monthlyRentCents: number;
}

export function LandlordQueue() {
  const [status, setStatus] = useState<QueueStatus>('submitted');
  const [declining, setDeclining] = useState<ApplicationSummary | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [deciding, setDeciding] = useState<string | null>(null);
  const [viewingDocs, setViewingDocs] = useState<ApplicationSummary | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [generatingFor, setGeneratingFor] = useState<ApplicationSummary | null>(null);
  const [withdrawing, setWithdrawing] = useState<ApplicationSummary | null>(null);
  const [terms, setTerms] = useState({ startDate: '', months: '12', escalationPct: '8', depositCents: null as number | null });
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // All three lists load, so each tab can say how many it holds before it is opened.
  const listOf = (which: QueueStatus) => ({
    queryKey: ['applications', which],
    queryFn: () => api.get<{ items: ApplicationSummary[] }>('/applications', { query: { status: which } }),
  });
  const lists = {
    submitted: useQuery(listOf('submitted')),
    approved: useQuery(listOf('approved')),
    declined: useQuery(listOf('declined')),
  };
  const { data, isLoading, isError, error, refetch } = lists[status];

  const { data: portfolio } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ items: { units: PortfolioUnit[] }[] }>('/properties'),
  });

  // One decision at a time, and a failure is said out loud: a double tap used to send two
  // decisions, and a refused one left the row in place with no explanation.
  const decide = async (id: string, outcome: 'approved' | 'declined', reason?: string) => {
    if (deciding) return;
    setDeciding(id);
    try {
      await api.post(`/applications/${id}/decision`, { outcome, reason });
      toast.show({ title: `Application ${outcome}`, tone: outcome === 'approved' ? 'success' : 'info' });
      setDeclining(null);
      setDeclineReason('');
      // Approving holds the unit and declining frees it, which the properties screen shows.
      // ['applications'] is a prefix: it refetches this list and home's pending count too.
      queryClient.invalidateQueries({ queryKey: ['properties'] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    } catch (error) {
      toast.show({ title: 'Decision not recorded', description: humanError(error), tone: 'danger' });
    } finally {
      setDeciding(null);
    }
  };

  // An approved applicant who went silent held the unit for good. Allowed until the lease is signed.
  const withdraw = async (item: ApplicationSummary) => {
    if (deciding) return;
    setDeciding(item.id);
    try {
      await api.post(`/applications/${item.id}/withdraw`, {});
      toast.show({ title: 'Application withdrawn', tone: 'info' });
      setWithdrawing(null);
      queryClient.invalidateQueries({ queryKey: ['properties'] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    } catch (error) {
      toast.show({ title: 'Not withdrawn', description: humanError(error), tone: 'danger' });
    } finally {
      setDeciding(null);
    }
  };
  const withdrawable = (item: ApplicationSummary) =>
    !item.leaseId || item.leaseStatus === 'draft' || item.leaseStatus === 'out_for_signature';

  const signing = (item: ApplicationSummary) =>
    !item.leaseStatus || item.leaseStatus === 'draft' || item.leaseStatus === 'out_for_signature';

  /** The same buttons in the laptop table and on the phone cards. */
  const actionsFor = (item: ApplicationSummary) => {
    if (status === 'submitted') {
      return (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={deciding !== null} onClick={() => setDeclining(item)}>
            Decline
          </Button>
          <Button size="sm" loading={deciding === item.id} disabled={deciding !== null} onClick={() => decide(item.id, 'approved')}>
            Approve
          </Button>
        </div>
      );
    }
    if (status === 'approved') {
      return (
        <div className="flex flex-wrap justify-end gap-2">
          {withdrawable(item) ? (
            <Button size="sm" variant="outline" disabled={deciding !== null} onClick={() => setWithdrawing(item)}>
              Withdraw
            </Button>
          ) : null}
          {item.leaseId ? (
            // Only a lease still being signed goes to the signing page; a live or ended one opens its details.
            signing(item) ? (
              <Button size="sm" variant="secondary" onClick={() => navigate(`/lease/${item.leaseId}`)}>
                Continue signing
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => navigate(`/leases/${item.leaseId}`)}>
                Open lease
              </Button>
            )
          ) : (
            <Button size="sm" loading={generating === item.id} onClick={() => openGenerate(item)}>
              Generate lease
            </Button>
          )}
        </div>
      );
    }
    return null;
  };

  // Always openable: the credit check lives in the same drawer, documents or not.
  const docsFor = (item: ApplicationSummary) => (
    <Button size="sm" variant={item.documentCount > 0 ? 'secondary' : 'outline'} onClick={() => setViewingDocs(item)}>
      {item.documentCount > 0 ? `${item.documentCount} on file` : 'No documents yet'}
    </Button>
  );

  const riskFor = (item: ApplicationSummary) => (
    <div>
      <Badge tone={bandTone[item.affordability.band]}>{incomeShare(item.affordability.ratio, ' of income')}</Badge>
      <p className="mt-1 text-xs text-ink-muted">{riskHint(item)}</p>
    </div>
  );

  const openGenerate = (item: ApplicationSummary) => {
    setTerms({ startDate: item.preferredMoveIn, months: '12', escalationPct: '8', depositCents: null });
    setGeneratingFor(item);
  };

  /** Generate, render, and land on the lease so the landlord signs while it is in hand. */
  const generateLease = async (item: ApplicationSummary) => {
    setGenerating(item.id);
    try {
      const result = await createAndRender(
        () =>
          api.post<{ id: string }>(`/applications/${item.id}/lease`, {
            startDate: terms.startDate,
            months: Number(terms.months),
            escalationPct: parsePercent(terms.escalationPct), // '7,5' is 7.5, not NaN
            // Left empty, the server uses the deposit set on the unit.
            ...(terms.depositCents !== null ? { depositCents: terms.depositCents } : {}),
          }),
        (leaseId) => api.post(`/leases/${leaseId}/render`, {}),
      );
      // The lease exists either way, so the row now offers "Continue signing".
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      if (result.rendered) {
        toast.show({ title: 'Lease generated', description: 'Sign it, then the tenant does.', tone: 'success' });
      } else {
        toast.show({
          title: 'Lease created, document not generated',
          description: `${humanError(result.renderError)} Generate it from the lease.`,
          tone: 'warning',
        });
      }
      setGeneratingFor(null);
      navigate(`/lease/${result.leaseId}`);
    } catch (error) {
      toast.show({ title: 'Lease not generated', description: humanError(error), tone: 'danger' });
    } finally {
      setGenerating(null);
    }
  };

  const items = data?.items ?? [];
  const units = (portfolio?.items ?? []).flatMap((property) => property.units);
  const vacant = units.filter((unit) => unit.status === 'vacant');

  const count = (which: QueueStatus) => lists[which].data?.items.length;
  const empty = !isLoading && !isError && items.length === 0;

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title="Applications"
        description={
          units.length === 0
            ? 'Approve, read the paperwork, generate the lease.'
            : vacant.length === 0
              ? 'Every unit is let.'
              : `${vacant.length} vacant: ${vacant.map((unit) => unit.code).join(', ')}.`
        }
      />

      <ListsTabs
        className="mb-5"
        label="Applications by decision"
        value={status}
        onChange={setStatus}
        options={[
          { label: 'Waiting', value: 'submitted', count: count('submitted'), tone: 'info' },
          { label: 'Approved', value: 'approved', count: count('approved') },
          { label: 'Declined', value: 'declined', count: count('declined') },
        ]}
      />

      {isError ? (
        <div className="mb-4">
          <QueryError error={error} onRetry={refetch} what="The queue" />
        </div>
      ) : null}
      {isLoading ? (
        <div className="p-8 text-center"><Spinner /></div>
      ) : null}

      {empty ? (
        <EmptyState
          title={EMPTY[status].title}
          description={EMPTY[status].description}
          action={status === 'submitted' ? <ListsLinkButton to="/properties" variant="primary" size="md">Go to Properties</ListsLinkButton> : undefined}
        />
      ) : null}

      {/* Phone: one card per applicant, every fact readable without scrolling sideways. */}
      <div className="space-y-3 md:hidden">
        {items.map((item) => (
          <Card key={`${item.id}-${item.leaseId ?? ''}`}>
            <CardBody className="space-y-3">
              <div className="flex items-center gap-3">
                <Avatar name={item.applicant} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-lead font-bold text-ink">{item.applicant}</p>
                  <p className="text-meta text-ink-muted">
                    {item.unit} · <Money whole cents={item.monthlyRentCents} className="font-semibold" /> a month
                  </p>
                </div>
              </div>
              {riskFor(item)}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-meta text-ink-muted">Moves in {formatDate(item.preferredMoveIn)}</p>
                {docsFor(item)}
              </div>
              {actionsFor(item) ? <div className="border-t border-line-soft pt-3">{actionsFor(item)}</div> : null}
            </CardBody>
          </Card>
        ))}
      </div>

      {items.length > 0 ? (
        <Card className="hidden overflow-hidden md:block">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line-soft text-meta text-ink-muted">
                <th scope="col" className="px-5 py-3 font-semibold">Applicant</th>
                <th scope="col" className="px-3 py-3 font-semibold">Rent to income</th>
                <th scope="col" className="px-3 py-3 font-semibold">Documents</th>
                <th scope="col" className="px-3 py-3 font-semibold">Move in</th>
                <th scope="col" className="px-5 py-3"><span className="sr-only">Decision</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {items.map((item) => (
                <tr key={`${item.id}-${item.leaseId ?? ''}`} className="align-middle">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <Avatar name={item.applicant} />
                      <div className="min-w-0">
                        <p className="text-body font-bold text-ink">{item.applicant}</p>
                        <p className="text-meta text-ink-muted">
                          {item.unit} · <Money whole cents={item.monthlyRentCents} className="font-semibold" /> a month
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3.5">{riskFor(item)}</td>
                  <td className="px-3 py-3.5">{docsFor(item)}</td>
                  <td className="whitespace-nowrap px-3 py-3.5 text-body text-ink">{formatDate(item.preferredMoveIn)}</td>
                  <td className="px-5 py-3.5">{actionsFor(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Modal
        open={!!declining}
        onOpenChange={(next) => {
          if (!next) {
            setDeclining(null);
            setDeclineReason('');
          }
        }}
        title="Decline this application"
        description="The applicant is told the reason, so write something they can act on."
        size="sm"
      >
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-meta font-semibold text-ink">Reason</span>
            <Textarea
              rows={3}
              placeholder="e.g. The rent is more than a third of the income shown on the payslips."
              value={declineReason}
              onChange={(event) => setDeclineReason(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeclining(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={declineReason.trim().length < 3}
              loading={deciding === declining?.id}
              onClick={() => declining && decide(declining.id, 'declined', declineReason.trim())}
            >
              Decline
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!withdrawing}
        onOpenChange={(next) => !next && setWithdrawing(null)}
        title={withdrawing ? `Withdraw ${withdrawing.applicant}'s application?` : 'Withdraw'}
        description="The unit is freed, any unsigned lease is cancelled, and the applicant is told."
        confirmLabel="Withdraw the application"
        loading={deciding === withdrawing?.id}
        onConfirm={() => withdrawing && withdraw(withdrawing)}
      />

      <Modal
        open={!!generatingFor}
        onOpenChange={(next) => !next && setGeneratingFor(null)}
        title={generatingFor ? `Lease for ${generatingFor.applicant}` : 'Lease'}
      >
        <div className="space-y-4">
          {generatingFor ? (
            <div className="flex items-center gap-3 rounded-md bg-surface-muted px-4 py-3">
              <Avatar name={generatingFor.applicant} />
              <p className="min-w-0 text-meta text-ink-muted">
                <span className="block text-body font-semibold text-ink">{generatingFor.unit}</span>
                Rent <Money whole cents={generatingFor.monthlyRentCents} className="text-ink" /> a month, from the unit.
                To change it, edit the unit under Properties first.
              </p>
            </div>
          ) : null}
          <div>
            <label htmlFor="lease-start" className="mb-1 block text-meta font-semibold text-ink">Start date</label>
            <Input
              id="lease-start"
              type="date"
              value={terms.startDate}
              onChange={(event) => setTerms({ ...terms, startDate: event.target.value })}
            />
            <p className="mt-1 text-xs text-ink-muted">Prefilled from their preferred move-in.</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="lease-term" className="mb-1 block text-meta font-semibold text-ink">Term</label>
              <Select
                id="lease-term"
                value={terms.months}
                onChange={(event) => setTerms({ ...terms, months: event.target.value })}
                options={TERM_OPTIONS}
              />
            </div>
            <div>
              <label htmlFor="lease-escalation" className="mb-1 block text-meta font-semibold text-ink">Escalation % a year</label>
              <Input
                id="lease-escalation"
                type="number"
                min={0}
                max={20}
                value={terms.escalationPct}
                onChange={(event) => setTerms({ ...terms, escalationPct: event.target.value })}
              />
            </div>
          </div>
          <div>
            <label htmlFor="lease-deposit" className="mb-1 block text-meta font-semibold text-ink">Deposit</label>
            <CurrencyInput
              id="lease-deposit"
              cents={terms.depositCents}
              onCentsChange={(next) => setTerms({ ...terms, depositCents: next })}
            />
            <p className="mt-1 text-xs text-ink-muted">Leave empty to use the deposit set on the unit.</p>
          </div>
          <Button
            block
            disabled={!terms.startDate}
            loading={generating === generatingFor?.id}
            onClick={() => generatingFor && generateLease(generatingFor)}
          >
            Generate and open it
          </Button>
        </div>
      </Modal>

      <DocumentsDrawer application={viewingDocs} onClose={() => setViewingDocs(null)} />
    </main>
  );
}

/** The paperwork behind the count: payslips and IDs open in a new tab on a short-lived link. */
function DocumentsDrawer({ application, onClose }: {
  application: ApplicationSummary | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['application-documents', application?.id],
    queryFn: () =>
      api.get<{ items: ApplicationDocument[] }>(`/applications/${application!.id}/documents`),
    enabled: Boolean(application),
  });

  return (
    <Drawer
      open={Boolean(application)}
      onOpenChange={(next) => !next && onClose()}
      title={application ? `${application.applicant} · documents and credit` : 'Documents'}
    >
      {isLoading ? (
        <div className="p-8 text-center"><Spinner /></div>
      ) : (
        <div className="space-y-2">
          {(data?.items ?? []).map((document) => (
            <a
              key={document.id}
              href={document.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between gap-3 rounded-md border border-line px-4 py-3 hover:bg-surface-muted"
            >
              <div>
                <p className="text-body font-semibold">{KIND_LABEL[document.kind] ?? document.kind}</p>
                <p className="text-xs text-ink-muted">
                  {(document.sizeBytes / 1024).toFixed(0)} KB · {formatInstant(document.uploadedAt)}
                </p>
              </div>
              <span className={listsButtonClass('outline', 'sm')}>Open</span>
            </a>
          ))}
          {data && data.items.length === 0 ? (
            <p className="text-body text-ink-muted">Nothing uploaded yet. The applicant adds an ID copy, payslips and bank statements from their application.</p>
          ) : null}
        </div>
      )}
      {application ? (
        <section aria-label="Credit check" className="mt-6 space-y-2 border-t border-line pt-4">
          <h3 className="text-lead font-bold text-ink">Credit check</h3>
          <CreditCheckPanel applicationId={application.id} />
        </section>
      ) : null}
    </Drawer>
  );
}
