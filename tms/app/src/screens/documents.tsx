import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Avatar, Badge, Button, Card, EmptyState, PageHeader, Select } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { Money } from '../components/money';
import { formatDate, status } from '../lib/format';
import { QueryState } from '../components/query-state';
import { currentLease, leaseDocumentBadge } from '../lib/leases';
import { useOpenDocument } from '../lib/open-document';
import { isLandlord } from '../lib/session';
import { PAGE } from '../lib/layout';

interface Lease {
  id: string; ref: string; unit: string; startDate: string; endDate: string; hasDocument: boolean;
  status: string; source: 'online' | 'import'; signatures: { party: string; signedAt: string }[];
  pdfKey: string | null;
  inspections: { id: string; kind: string; status: string; scheduledFor: string; flagged: number; reportKey: string | null }[];
  invoices: { id: string; period: string; dueOn: string; totalCents: number; status: string; pdfKey: string | null }[];
  termination: { refundDueBy: string | null; statementKey: string | null } | null;
}

interface LeaseRow { id: string; ref: string; status: string; unit?: string; tenant?: string }

/** The server sends the newest invoices only; the page must not promise more than it lists. */
const INVOICE_LIMIT = 12;

const leaseLabel = (item: LeaseRow) =>
  `${item.ref}${item.status === 'terminated' ? ' (ended)' : item.status === 'active' ? ' (current)' : ''}`;

/** Everything on the tenancy that is a document, in one place, because when something is
    disputed this is the list a tribunal asks for. */
export function Documents() {
  const openDocument = useOpenDocument();
  const navigate = useNavigate();
  const landlord = isLandlord();
  // Ended leases too: settling the deposit ends the lease, and its statement appears only then.
  const list = useQuery({
    queryKey: ['leases', 'with-ended'],
    queryFn: () => api.get<{ items: LeaseRow[] }>('/leases', { query: { include: 'ended' } }),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  // The current tenancy's documents, not an accepted renewal's that has not started yet. An
  // earlier lease (the move-in report sits on the first lease of a renewed chain) can be picked.
  // A landlord has many leases and no "current" one, so nothing is shown until they choose:
  // the newest lease in the portfolio is not what they came for.
  const leaseId =
    (picked && items.some((item) => item.id === picked) ? picked : null) ?? (landlord ? undefined : currentLease(items)?.id);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<Lease>(`/leases/${leaseId}`),
    enabled: Boolean(leaseId),
  });

  if (landlord && list.isSuccess && !leaseId) {
    return (
      <main className={PAGE.wide}>
        <PageHeader
          title="Documents"
          description="Each lease keeps its own papers: the signed lease, inspection reports, invoices and the deposit statement."
        />
        {items.length === 0 ? (
          <EmptyState
            title="No leases yet"
            description="Once a tenant signs a lease, its documents are filed here."
            action={<Button onClick={() => navigate('/applications')}>See applications</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <Card>
              <div className="px-5 py-4">
                <h2 className="text-lead font-bold text-ink">Choose a lease</h2>
                <p className="text-meta text-ink-muted">{items.length === 1 ? '1 lease' : `${items.length} leases`}, newest first.</p>
              </div>
              <ul className="divide-y divide-line-soft border-t border-line-soft">
                {items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                    <Avatar name={item.tenant ?? item.ref} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body font-semibold text-ink">{item.tenant ?? item.ref}</p>
                      <p className="truncate text-meta text-ink-muted">{[item.unit, item.ref].filter(Boolean).join(' · ')}</p>
                    </div>
                    <Badge tone={status(item.status).tone}>{status(item.status).label}</Badge>
                    <Button size="sm" variant="outline" aria-label={`Show documents for ${item.ref}`} onClick={() => setPicked(item.id)}>
                      Show documents
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
            <Note title="Looking for something else?">
              Rent statements and tax figures are under Reports. Slips your tenants send are under Payments.
            </Note>
          </div>
        )}
      </main>
    );
  }

  if (!data) {
    // "Nothing filed yet" is only true once the list has actually answered with no lease.
    if (list.isSuccess && !leaseId) {
      return (
        <main className={PAGE.wide}>
          <PageHeader title="Documents" />
          <EmptyState
            title="Nothing filed yet"
            description="Documents appear as your tenancy produces them: your lease first, then inspection reports and invoices."
            action={<Button variant="outline" onClick={() => navigate('/')}>Back to home</Button>}
          />
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

  const paper = leaseDocumentBadge(data);

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title="Documents"
        description={
          landlord
            ? `The papers on ${data.ref}: the lease, each inspection and the latest invoices.`
            : 'Your lease, every inspection and your latest invoices. Keep these; they are what settles a dispute.'
        }
        actions={landlord ? <Button variant="outline" onClick={() => setPicked(null)}>All leases</Button> : undefined}
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <Group title="Lease">
            <Row
              pill={<Badge tone="brand">Lease</Badge>}
              title={data.ref}
              detail={data.unit}
              date={`${formatDate(data.startDate)} to ${formatDate(data.endDate)}`}
              state={<Badge tone={paper.tone}>{paper.label}</Badge>}
              action={
                data.pdfKey ? (
                  <Button size="sm" variant="outline" aria-label="Open the lease" onClick={() => openDocument(data.pdfKey!)}>
                    Open
                  </Button>
                ) : null
              }
            />
          </Group>

          <Group title="Inspections">
            {data.inspections.length === 0 ? (
              <Quiet>None yet. The move-in inspection and its defects list become part of your lease.</Quiet>
            ) : null}
            {data.inspections.map((inspection) => {
              const kind = inspection.kind === 'incoming' ? 'Move in' : 'Move out';
              return (
                <Row
                  key={inspection.id}
                  pill={<Badge tone="info">Inspection</Badge>}
                  title={kind}
                  detail={inspection.flagged > 0 ? `${inspection.flagged} items flagged` : 'Nothing flagged'}
                  date={formatDate(inspection.scheduledFor)}
                  state={
                    <Badge tone={inspection.status === 'completed' ? 'success' : 'warning'}>
                      {status(inspection.status).label}
                    </Badge>
                  }
                  action={
                    inspection.reportKey ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Open the ${kind.toLowerCase()} report of ${formatDate(inspection.scheduledFor)}`}
                        onClick={() => openDocument(inspection.reportKey!)}
                      >
                        Open
                      </Button>
                    ) : null
                  }
                />
              );
            })}
          </Group>

          {data.termination?.statementKey ? (
            <Group title="Deposit statement">
              <Row
                pill={<Badge tone="warning">Deposit</Badge>}
                title="Final statement"
                detail="The final reconciliation of your deposit, its interest and every deduction."
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label="Open the deposit statement"
                    onClick={() => openDocument(data.termination!.statementKey!)}
                  >
                    Open
                  </Button>
                }
              />
            </Group>
          ) : null}

          <Group
            title="Invoices"
            hint={data.invoices.length >= INVOICE_LIMIT ? `The latest ${INVOICE_LIMIT} are listed.` : undefined}
          >
            {data.invoices.length === 0 ? <Quiet>None issued yet.</Quiet> : null}
            {data.invoices.map((invoice) => (
              <Row
                key={invoice.id}
                pill={<Badge>Invoice</Badge>}
                title={invoice.period}
                detail={<Money cents={invoice.totalCents} className="font-semibold text-ink" />}
                date={`Due ${formatDate(invoice.dueOn)}`}
                state={<Badge tone={status(invoice.status).tone}>{status(invoice.status).label}</Badge>}
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`PDF of the invoice for ${invoice.period}`}
                    onClick={() =>
                      openDocument(
                        invoice.pdfKey ??
                          (async () => (await api.post<{ key: string }>(`/invoices/${invoice.id}/render`, {})).key),
                      )
                    }
                  >
                    PDF
                  </Button>
                }
              />
            ))}
          </Group>
        </div>

        <aside className="space-y-5">
          <Card>
            <div className="space-y-3 px-5 py-4">
              <h2 className="text-lead font-bold text-ink">This tenancy</h2>
              <dl className="space-y-2 text-meta">
                <Fact label="Unit">{data.unit}</Fact>
                <Fact label="Reference">{data.ref}</Fact>
                <Fact label="Runs">{formatDate(data.startDate)} to {formatDate(data.endDate)}</Fact>
                <Fact label="Status"><Badge tone={status(data.status).tone}>{status(data.status).label}</Badge></Fact>
              </dl>
              {items.length > 1 ? (
                <div className="space-y-1.5 border-t border-line-soft pt-3">
                  <label htmlFor="documents-lease" className="block text-meta font-semibold text-ink">
                    {landlord ? 'Show another lease' : 'Show an earlier lease'}
                  </label>
                  <Select
                    id="documents-lease"
                    aria-label="Lease"
                    value={leaseId ?? ''}
                    onChange={(event) => setPicked(event.target.value)}
                    options={items.map((item) => ({
                      value: item.id,
                      label: landlord && item.tenant ? `${leaseLabel(item)}, ${item.tenant}` : leaseLabel(item),
                    }))}
                  />
                </div>
              ) : null}
              {landlord ? (
                <Link to={`/leases/${data.id}`} className="inline-block text-meta font-semibold text-brand-600 underline underline-offset-2">
                  Go to the lease
                </Link>
              ) : null}
            </div>
          </Card>
          <Note title="Why these matter">
            If a deposit or a repair is ever disputed, the Rental Housing Tribunal asks for the signed lease and both
            inspection reports. They stay here after the lease ends.
          </Note>
        </aside>
      </div>
    </main>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-5 py-4">
          <h2 className="text-lead font-bold text-ink">{title}</h2>
          {hint ? <p className="text-meta text-ink-muted">{hint}</p> : null}
        </div>
        <div className="divide-y divide-line-soft border-t border-line-soft">{children}</div>
      </Card>
    </section>
  );
}

/** One document: what kind, what it is, its date in a quiet column, its state, and the button. */
function Row({
  pill, title, detail, date, state, action,
}: {
  pill: ReactNode; title: string; detail?: ReactNode; date?: string; state?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3.5 sm:grid-cols-[6.5rem_minmax(0,1fr)_11rem_auto_4.5rem]">
      <div className="hidden sm:block">{pill}</div>
      <div className="min-w-0">
        <p className="text-body font-semibold text-ink">{title}</p>
        {detail ? <p className="text-meta text-ink-muted">{detail}</p> : null}
        {date ? <p className="text-meta text-ink-muted sm:hidden">{date}</p> : null}
      </div>
      <p className="hidden text-meta text-ink-muted sm:block">{date}</p>
      <div className="col-start-1 row-start-2 sm:col-auto sm:row-auto sm:justify-self-end">{state}</div>
      <div className="col-start-2 row-span-2 row-start-1 justify-self-end sm:col-auto sm:row-auto">{action}</div>
    </div>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="px-5 py-4 text-body text-ink-muted">{children}</p>
);

const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-ink-muted">{label}</dt>
    <dd className="text-right font-medium text-ink">{children}</dd>
  </div>
);

const Note = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="rounded-md border border-[color-mix(in_srgb,var(--tb-info)_25%,transparent)] bg-tint-info px-5 py-4">
    <h2 className="text-body font-bold text-ink">{title}</h2>
    <p className="mt-1 text-meta text-ink">{children}</p>
  </div>
);
