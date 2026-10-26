import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Drawer,
  Input,
  Modal,
  PageHeader,
  Select,
  SegmentedControl,
  Spinner,
  StatCard,
  useToast,
} from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, type ApplicationSummary, humanError } from '../api/client';

const bandTone = { comfortable: 'success', tight: 'warning', over: 'danger' } as const;

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
};

interface PortfolioUnit {
  code: string;
  status: string;
  monthlyRentCents: number;
}

export function LandlordQueue() {
  const [status, setStatus] = useState<'submitted' | 'approved' | 'declined'>('submitted');
  const [declining, setDeclining] = useState<ApplicationSummary | null>(null);
  const [viewingDocs, setViewingDocs] = useState<ApplicationSummary | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [generatingFor, setGeneratingFor] = useState<ApplicationSummary | null>(null);
  const [terms, setTerms] = useState({ startDate: '', months: '12', escalationPct: '8' });
  const toast = useToast();
  const navigate = useNavigate();

  const { data, refetch } = useQuery({
    queryKey: ['applications', status],
    queryFn: () => api.get<{ items: ApplicationSummary[] }>('/applications', { query: { status } }),
  });

  const { data: portfolio } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ items: { units: PortfolioUnit[] }[] }>('/properties'),
  });

  const decide = async (id: string, outcome: 'approved' | 'declined', reason?: string) => {
    await api.post(`/applications/${id}/decision`, { outcome, reason });
    toast.show({ title: `Application ${outcome}`, tone: outcome === 'approved' ? 'success' : 'info' });
    setDeclining(null);
    refetch();
  };

  const openGenerate = (item: ApplicationSummary) => {
    setTerms({ startDate: item.preferredMoveIn, months: '12', escalationPct: '8' });
    setGeneratingFor(item);
  };

  /** Generate, render, and land on the lease so the landlord signs while it is in hand. */
  const generateLease = async (item: ApplicationSummary) => {
    setGenerating(item.id);
    try {
      const lease = await api.post<{ id: string }>(`/applications/${item.id}/lease`, {
        startDate: terms.startDate,
        months: Number(terms.months),
        escalationPct: Number(terms.escalationPct),
      });
      await api.post(`/leases/${lease.id}/render`, {});
      toast.show({ title: 'Lease generated', description: 'Sign it, then the tenant does.', tone: 'success' });
      setGeneratingFor(null);
      navigate(`/lease/${lease.id}`);
    } catch (error) {
      toast.show({ title: 'Lease not generated', description: humanError(error), tone: 'danger' });
    } finally {
      setGenerating(null);
    }
  };

  const items = data?.items ?? [];
  const units = (portfolio?.items ?? []).flatMap((property) => property.units);
  const vacant = units.filter((unit) => unit.status === 'vacant');
  const rentRoll = units
    .filter((unit) => unit.status === 'occupied')
    .reduce((sum, unit) => sum + unit.monthlyRentCents, 0);

  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader
        title="Applications"
        description="Approve, read the paperwork, generate the lease."
        breadcrumbs={[{ label: 'Manage' }, { label: 'Applications' }]}
        actions={
          <Button size="sm" variant="outline" onClick={() => navigate('/properties')}>
            Properties
          </Button>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Waiting on you" value={String(status === 'submitted' ? items.length : '—')} />
        <StatCard
          label="Vacant units"
          value={String(vacant.length)}
          delta={vacant.map((unit) => unit.code).join(', ') || 'fully let'}
        />
        <StatCard label="Occupied" value={String(units.length - vacant.length)} deltaTone="neutral" />
        <StatCard label="Monthly rent roll" value={formatZar(rentRoll / 100, false)} />
      </div>

      <SegmentedControl
        className="mb-4"
        value={status}
        onChange={setStatus}
        options={[
          { label: 'Waiting', value: 'submitted' },
          { label: 'Approved', value: 'approved' },
          { label: 'Declined', value: 'declined' },
        ]}
      />

      <DataTable
        data={items}
        emptyTitle="No applications here"
        columns={[
          { accessorKey: 'applicant', header: 'Applicant' },
          { accessorKey: 'unit', header: 'Unit' },
          {
            id: 'affordability',
            header: 'Rent to income',
            cell: ({ row }) => {
              const item = row.original as ApplicationSummary;
              return (
                <Badge tone={bandTone[item.affordability.band]}>
                  {Math.round(item.affordability.ratio * 100)}%
                </Badge>
              );
            },
          },
          {
            id: 'documents',
            header: 'Docs',
            cell: ({ row }) => {
              const item = row.original as ApplicationSummary;
              return item.documentCount > 0 ? (
                <button
                  type="button"
                  className="text-[13px] font-bold text-brand-500"
                  onClick={() => setViewingDocs(item)}
                >
                  {item.documentCount} on file
                </button>
              ) : (
                <span className="text-[13px] text-ink-muted">none</span>
              );
            },
          },
          { accessorKey: 'preferredMoveIn', header: 'Move in' },
          {
            id: 'actions',
            header: '',
            cell: ({ row }) => {
              const item = row.original as ApplicationSummary;
              if (status === 'submitted') {
                return (
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setDeclining(item)}>
                      Decline
                    </Button>
                    <Button size="sm" onClick={() => decide(item.id, 'approved')}>
                      Approve
                    </Button>
                  </div>
                );
              }
              if (status === 'approved') {
                return (
                  <div className="flex justify-end">
                    {item.leaseId ? (
                      <Button size="sm" variant="outline" onClick={() => navigate(`/lease/${item.leaseId}`)}>
                        {item.leaseStatus === 'active' ? 'Open lease' : 'Continue signing'}
                      </Button>
                    ) : (
                      <Button size="sm" loading={generating === item.id} onClick={() => openGenerate(item)}>
                        Generate lease
                      </Button>
                    )}
                  </div>
                );
              }
              return null;
            },
          },
        ]}
      />

      <ConfirmDialog
        open={!!declining}
        onOpenChange={() => setDeclining(null)}
        title="Decline this application"
        description="The applicant is told the reason, so write something they can act on."
        confirmLabel="Decline"
        onConfirm={() => declining && decide(declining.id, 'declined', 'Rent exceeds a third of income.')}
      />

      <Modal
        open={!!generatingFor}
        onOpenChange={(next) => !next && setGeneratingFor(null)}
        title={generatingFor ? `Lease for ${generatingFor.applicant}` : 'Lease'}
      >
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-[13px] font-medium">Start date</p>
            <Input
              type="date"
              value={terms.startDate}
              onChange={(event) => setTerms({ ...terms, startDate: event.target.value })}
            />
            <p className="mt-1 text-xs text-ink-muted">Prefilled from their preferred move-in.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="mb-1 text-[13px] font-medium">Term</p>
              <Select
                value={terms.months}
                onChange={(event) => setTerms({ ...terms, months: event.target.value })}
                options={[
                  { value: '6', label: '6 months' },
                  { value: '12', label: '12 months' },
                  { value: '18', label: '18 months' },
                  { value: '24', label: '24 months' },
                ]}
              />
            </div>
            <div>
              <p className="mb-1 text-[13px] font-medium">Escalation % a year</p>
              <Input
                type="number"
                min={0}
                max={20}
                value={terms.escalationPct}
                onChange={(event) => setTerms({ ...terms, escalationPct: event.target.value })}
              />
            </div>
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
      title={application ? `${application.applicant} · documents` : 'Documents'}
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
              className="flex items-center justify-between rounded-sm border border-line-soft px-3 py-2.5 hover:border-brand-500"
            >
              <div>
                <p className="text-[14px] font-semibold">{KIND_LABEL[document.kind] ?? document.kind}</p>
                <p className="text-xs text-ink-muted">
                  {(document.sizeBytes / 1024).toFixed(0)} KB · {document.uploadedAt.slice(0, 10)}
                </p>
              </div>
              <span className="text-[13px] font-bold text-brand-500">Open</span>
            </a>
          ))}
          {data && data.items.length === 0 ? (
            <p className="text-[13.5px] text-ink-muted">Nothing uploaded yet.</p>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
