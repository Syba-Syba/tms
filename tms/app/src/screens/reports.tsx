import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import {
  Alert, Avatar, Badge, Button, Card, ConfirmDialog, CurrencyInput, EmptyState, Input, Modal, PageHeader, Select,
  Spinner, Tabs, useToast,
} from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { useOpenDocument } from '../lib/open-document';
import { QueryError } from '../components/query-state';
import { formatDate } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import { PAGE } from '../lib/layout';
import { addDays, localToday } from '../lib/dates';
import { Money } from '../components/money';

const CATEGORIES: Record<string, string> = {
  rates: 'Rates',
  levies: 'Levies',
  insurance: 'Insurance',
  repairs: 'Repairs and maintenance',
  utilities: 'Water and electricity',
  bond_interest: 'Bond interest',
  agent_fees: 'Agent fees',
  bank_charges: 'Bank charges',
  legal: 'Legal and accounting',
  advertising: 'Advertising',
  other: 'Other',
};

interface IncomeRow {
  propertyId: string | null;
  property: string;
  invoicedCents: number;
  collectedCents: number;
  expenseCents: Record<string, number>;
  expensesCents: number;
  netCents: number;
}

interface IncomeReport {
  from: string;
  to: string;
  items: IncomeRow[];
  totals: IncomeRow;
}

type Bucket = 'current' | 'd30' | 'd60' | 'd90' | 'd90plus';
interface ArrearsReport {
  asOf: string;
  items: {
    leaseId: string;
    leaseRef: string;
    tenant: string;
    unit: string;
    oldestDueOn: string;
    proofPending: boolean;
    stage: 'reminder_1' | 'reminder_3' | 'reminder_7' | 'letter_of_demand' | null;
    stageOn: string | null;
    pausedUntil: string | null;
    ageing: Record<Bucket, number>;
    totalCents: number;
  }[];
  totals: { ageing: Record<Bucket, number>; totalCents: number };
}

interface Expense {
  id: string;
  propertyId: string | null;
  property: string | null;
  unitId: string | null;
  unit: string | null;
  category: string;
  description: string;
  amountCents: number;
  incurredOn: string;
  slipKey: string | null;
}

interface Property {
  id: string;
  name: string;
  units: { id: string | null; code: string | null }[];
}

const zar = (cents: number) => formatZar(cents / 100);
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd30', label: '1 to 30 days' },
  { key: 'd60', label: '31 to 60' },
  { key: 'd90', label: '61 to 90' },
  { key: 'd90plus', label: 'Over 90' },
];

/** The South African tax year runs 1 March to the end of February, named for the year it ends. */
function taxYear(endingIn: number) {
  const lastDay = new Date(Date.UTC(endingIn, 2, 0)).getUTCDate();
  return { from: `${endingIn - 1}-03-01`, to: `${endingIn}-02-${String(lastDay).padStart(2, '0')}` };
}
// The device's calendar (SAST for our users), not UTC: before 02:00 UTC was still yesterday,
// and on the 1st that put 'this month' in last month.
const today = localToday;
const currentTaxYear = () => {
  const [year, month] = today().split('-').map(Number) as [number, number];
  return month >= 3 ? year + 1 : year;
};

function periods() {
  const now = currentTaxYear();
  const monthStart = `${today().slice(0, 7)}-01`;
  // The day before this month began, on the same local calendar as monthStart.
  const lastMonthEnd = addDays(monthStart, -1);
  return [
    { value: 'this-tax-year', label: `This tax year (${now - 1}/${String(now).slice(2)})`, ...taxYear(now) },
    { value: 'last-tax-year', label: `Last tax year (${now - 2}/${String(now - 1).slice(2)})`, ...taxYear(now - 1) },
    { value: 'this-month', label: 'This month', from: monthStart, to: today() },
    { value: 'last-month', label: 'Last month', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
  ];
}

const rands = (cents: number) => (cents / 100).toFixed(2);

/** What the portfolio earned, who owes what, and the costs behind both. */
export function Reports() {
  return (
    <main className={PAGE.wide}>
      <PageHeader title="Reports" description="Income, costs and arrears, ready for your accountant." />
      <Tabs
        items={[
          { value: 'income', label: 'Income and expenses', content: <IncomeExpense /> },
          { value: 'arrears', label: 'Arrears', content: <Arrears /> },
          { value: 'expenses', label: 'Expenses', content: <Expenses /> },
        ]}
      />
    </main>
  );
}

/** The controls above a report: what it covers on the left, what you can do with it on the right. */
function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 shadow-sm">
      {children}
    </div>
  );
}

function PeriodPicker({ id, value, onChange, options }: {
  id: string; value: string; onChange: (next: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className="min-w-0 flex-1 basis-56 sm:max-w-xs">
      <label htmlFor={id} className="mb-1 block text-meta font-semibold text-ink-muted">Period</label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} options={options} />
    </div>
  );
}

/** A headline figure. `bad` is the one number that needs attention, on a red tint. */
function Tile({ label, cents, note, bad, children }: {
  label: string; cents: number; note?: ReactNode; bad?: boolean; children?: ReactNode;
}) {
  return (
    <div className={`rounded-md border px-5 py-4 shadow-sm ${bad ? 'border-[color-mix(in_srgb,var(--tb-danger)_30%,transparent)] bg-tint-danger' : 'border-line bg-surface'}`}>
      <p className="text-meta font-medium text-ink-muted">{label}</p>
      <p className={`mt-1.5 text-figure ${bad ? 'text-danger' : 'text-ink'}`}><Money cents={cents} whole /></p>
      {note ? <p className="mt-1 text-meta text-ink-muted">{note}</p> : null}
      {children}
    </div>
  );
}

const share = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.max(0, Math.round((part / whole) * 100))) : 0);

function IncomeExpense() {
  const options = periods();
  const [period, setPeriod] = useState(options[0]!.value);
  const range = options.find((option) => option.value === period)!;
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['report-income', range.from, range.to],
    queryFn: () => api.get<IncomeReport>(`/reports/income-expense?from=${range.from}&to=${range.to}`),
  });

  const used = data
    ? Object.keys(CATEGORIES).filter((category) => (data.totals.expenseCents?.[category] ?? 0) > 0)
    : [];

  const exportCsv = () => {
    if (!data) return;
    const header = ['Property', 'Rent invoiced', 'Rent collected', ...used.map((c) => CATEGORIES[c]!), 'Total expenses', 'Net (collected less expenses)'];
    const line = (row: IncomeRow) => [
      row.property, rands(row.invoicedCents), rands(row.collectedCents),
      ...used.map((c) => rands(row.expenseCents[c] ?? 0)), rands(row.expensesCents), rands(row.netCents),
    ];
    downloadCsv(`income-expenses-${data.from}-to-${data.to}.csv`, [
      [`Income and expenses, ${data.from} to ${data.to}`],
      header,
      ...data.items.map(line),
      line(data.totals),
    ]);
  };

  const hidden = data ? (data.items ?? []).filter((row) => !active(row)).length : 0;

  return (
    <div className="space-y-5">
      <Toolbar>
        <PeriodPicker id="income-period" value={period} onChange={setPeriod} options={options.map(({ value, label }) => ({ value, label }))} />
        <Button variant="outline" disabled={!data} onClick={exportCsv}>Download CSV</Button>
      </Toolbar>
      {isError ? (
        <QueryError error={error} onRetry={() => void refetch()} what="The report" />
      ) : isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Tile label="Rent invoiced" cents={data.totals.invoicedCents ?? 0} note={`${formatDate(data.from)} to ${formatDate(data.to)}`} />
            <Tile
              label="Rent collected"
              cents={data.totals.collectedCents ?? 0}
              note={`${share(data.totals.collectedCents ?? 0, data.totals.invoicedCents ?? 0)}% of what was invoiced`}
            >
              <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
                <div className="h-full rounded-full bg-brand-500" style={{ width: `${share(data.totals.collectedCents ?? 0, data.totals.invoicedCents ?? 0)}%` }} />
              </div>
            </Tile>
            <Tile
              label="Expenses"
              cents={data.totals.expensesCents ?? 0}
              note={used.length === 0 ? 'None recorded' : used.length === 1 ? 'In 1 category' : `Across ${used.length} categories`}
            />
            <Tile
              label="Net for the period"
              cents={data.totals.netCents ?? 0}
              bad={(data.totals.netCents ?? 0) < 0}
              note={(data.totals.netCents ?? 0) < 0 ? 'Costs were more than rent collected' : 'Rent collected less expenses'}
            />
          </div>

          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <Card>
              <div className="px-5 py-4">
                <h2 className="text-lead font-bold text-ink">Statement by property</h2>
                <p className="text-meta text-ink-muted">Rent collected, less each cost, for every property.</p>
              </div>
              <div className="border-t border-line-soft px-5 pb-2">
                <Ledger rows={(data.items ?? []).filter(active)} totals={data.totals} />
              </div>
              {hidden > 0 ? (
                <p className="border-t border-line-soft px-5 py-3 text-meta text-ink-muted">
                  {hidden === 1
                    ? '1 property with no rent or expenses in this period is hidden here and included in the CSV.'
                    : `${hidden} properties with no rent or expenses in this period are hidden here and included in the CSV.`}
                </p>
              ) : null}
            </Card>

            <aside className="space-y-5">
              <Card>
                <div className="px-5 py-4">
                  <h2 className="text-lead font-bold text-ink">Where the money went</h2>
                  {used.length === 0 ? (
                    <p className="mt-1 text-meta text-ink-muted">
                      No expenses in this period. Add rates, levies and repairs under the Expenses tab so the net figure is right.
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-3">
                      {used
                        .map((category) => ({ category, cents: data.totals.expenseCents[category] ?? 0 }))
                        .sort((a, b) => b.cents - a.cents)
                        .map(({ category, cents }) => (
                          <li key={category}>
                            <div className="flex items-baseline justify-between gap-3 text-meta">
                              <span className="text-ink">{CATEGORIES[category]}</span>
                              <span className="text-ink-muted">{zar(cents)}</span>
                            </div>
                            <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
                              <div className="h-full rounded-full bg-brand-400" style={{ width: `${share(cents, data.totals.expensesCents)}%` }} />
                            </div>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              </Card>
              <div className="rounded-md border border-[color-mix(in_srgb,var(--tb-info)_25%,transparent)] bg-tint-info px-5 py-4">
                <h2 className="text-body font-bold text-ink">How to read this</h2>
                <p className="mt-1 text-meta text-ink">
                  Net is rent collected less expenses, the cash view SARS starts from. Deposits are not income
                  and are left out. Bond capital is not deductible; record only the interest.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

const active = (row: IncomeRow) => row.invoicedCents > 0 || row.collectedCents > 0 || row.expensesCents > 0;

/**
 * Income and expenses as one statement: each property a group of ruled lines, its net on the
 * heading row, and the period's totals under a heavy rule at the foot.
 */
function Ledger({ rows, totals }: { rows: IncomeRow[]; totals: IncomeRow }) {
  return (
    <table className="w-full text-body">
      <caption className="sr-only">Income and expenses by property</caption>
      <thead className="sr-only">
        <tr><th scope="col">Item</th><th scope="col">Amount</th></tr>
      </thead>
      {rows.map((row) => (
        <tbody key={row.propertyId ?? 'none'} className="border-b border-line">
          <tr>
            <th scope="rowgroup" className="pb-1.5 pt-4 text-left text-lead font-bold text-ink">{row.property}</th>
            <td className={`pb-1.5 pt-4 text-right text-lead ${row.netCents < 0 ? 'text-danger' : 'text-ink'}`}>
              <Money cents={row.netCents} />
            </td>
          </tr>
          <Line label="Collected" cents={row.collectedCents} hint={`of ${zar(row.invoicedCents)} invoiced`} />
          {Object.keys(CATEGORIES)
            .filter((category) => (row.expenseCents[category] ?? 0) > 0)
            .map((category) => (
              <Line key={category} label={CATEGORIES[category]!} cents={-(row.expenseCents[category] ?? 0)} />
            ))}
          <tr aria-hidden><td colSpan={2} className="h-3" /></tr>
        </tbody>
      ))}
      <tfoot>
        <Line label="Rent invoiced" cents={totals.invoicedCents ?? 0} first />
        <Line label="Rent collected" cents={totals.collectedCents ?? 0} />
        <Line label="Expenses" cents={-(totals.expensesCents ?? 0)} />
        <tr className="border-t-2 border-ink">
          <th scope="row" className="py-3.5 text-left text-lead font-bold text-ink">Net for the period</th>
          <td className={`py-3.5 text-right text-title ${(totals.netCents ?? 0) < 0 ? 'text-danger' : 'text-ink'}`}>
            <Money cents={totals.netCents ?? 0} />
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function Line({ label, cents, hint, first }: { label: string; cents: number; hint?: string; first?: boolean }) {
  const pad = first ? 'pb-1.5 pt-4' : 'py-1.5';
  return (
    <tr>
      <th scope="row" className={`${pad} text-left font-normal text-ink-muted`}>
        {label}
        {hint ? <span className="ml-1 text-meta">({hint})</span> : null}
      </th>
      <td className={`${pad} text-right`}><Money cents={cents} className="font-medium text-ink" /></td>
    </tr>
  );
}

const STAGE_LABEL = {
  reminder_1: 'First reminder',
  reminder_3: 'Second reminder',
  reminder_7: 'Final reminder',
  letter_of_demand: 'Letter of demand',
} as const;

/** Where a debt stands on the ladder, in words a landlord can act on. */
function stageText(item: ArrearsReport['items'][number]): string {
  if (item.pausedUntil) return `Reminders paused until ${formatDate(item.pausedUntil)}`;
  if (!item.stage || !item.stageOn) return '';
  return `${STAGE_LABEL[item.stage]} ${formatDate(item.stageOn)}${item.stage === 'reminder_7' ? ', letter ready' : ''}`;
}

/** Older debt is redder. The label beside each bar says the age in words, so colour is never alone. */
const BUCKET_BAR: Record<Bucket, string> = {
  current: 'bg-neutral-400',
  d30: 'bg-[color-mix(in_srgb,var(--tb-warning)_60%,var(--tb-surface))]',
  d60: 'bg-warning',
  d90: 'bg-[color-mix(in_srgb,var(--tb-danger)_65%,var(--tb-surface))]',
  d90plus: 'bg-danger',
};

function Arrears() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['report-arrears'],
    queryFn: () => api.get<ArrearsReport>('/reports/arrears'),
  });
  if (isError) return <QueryError error={error} onRetry={() => void refetch()} what="The arrears report" />;
  if (isLoading || !data) return <Spinner />;

  const exportCsv = () =>
    downloadCsv(`arrears-${data.asOf}.csv`, [
      [`Arrears as of ${data.asOf}`],
      ['Unit', 'Tenant', 'Reference', 'Stage', ...BUCKETS.map((b) => b.label), 'Total'],
      ...data.items.map((item) => [
        item.unit, item.tenant, item.leaseRef, stageText(item),
        ...BUCKETS.map((b) => rands(item.ageing[b.key])), rands(item.totalCents),
      ]),
      ['Total', '', '', '', ...BUCKETS.map((b) => rands(data.totals.ageing[b.key])), rands(data.totals.totalCents)],
    ]);

  const ageing = data.totals.ageing ?? ({} as Record<Bucket, number>);
  const largest = Math.max(1, ...BUCKETS.map((bucket) => ageing[bucket.key] ?? 0));
  const owing = data.totals.totalCents > 0;

  return (
    <div className="space-y-5">
      <Toolbar>
        <p className="min-w-0 flex-1 basis-56 self-center text-body text-ink">
          {owing ? <>{zar(data.totals.totalCents)} owed across {data.items.length} {data.items.length === 1 ? 'lease' : 'leases'}.</> : 'Nobody owes anything.'}
          {data.asOf ? <span className="text-ink-muted"> As of {formatDate(data.asOf)}.</span> : null}
        </p>
        <Button variant="outline" disabled={data.items.length === 0} onClick={exportCsv}>Download CSV</Button>
      </Toolbar>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="space-y-5">
          <Tile
            label="Owed in total"
            cents={data.totals.totalCents}
            bad={owing}
            note={owing ? `${data.items.length} ${data.items.length === 1 ? 'lease has' : 'leases have'} rent owing` : 'Every invoice sent so far is paid'}
          />
          <Card>
            <div className="px-5 py-4">
              <h2 className="text-lead font-bold text-ink">How old the debt is</h2>
              <dl className="mt-3 space-y-3">
                {BUCKETS.map((bucket) => (
                  <div key={bucket.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-meta text-ink">{bucket.label}</dt>
                      <dd className="text-meta text-ink"><Money cents={ageing[bucket.key] ?? 0} whole /></dd>
                    </div>
                    <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
                      <div className={`h-full rounded-full ${BUCKET_BAR[bucket.key]}`} style={{ width: `${share(ageing[bucket.key] ?? 0, largest)}%` }} />
                    </div>
                  </div>
                ))}
              </dl>
            </div>
          </Card>
        </div>

        {data.items.length === 0 ? (
          <EmptyState
            title="No arrears"
            description="Every invoice is paid. A tenant who falls behind is listed here with how old the debt is and which reminder they have had."
            action={<Button variant="outline" onClick={() => navigate('/payments')}>Go to payments</Button>}
          />
        ) : (
          <Card>
            <div className="px-5 py-4">
              <h2 className="text-lead font-bold text-ink">Who owes what</h2>
              <p className="text-meta text-ink-muted">Largest first. Open a lease to record a payment or pause reminders.</p>
            </div>
            <ul className="divide-y divide-line-soft border-t border-line-soft">
              {data.items.map((item) => {
                const late = BUCKETS.some((bucket) => bucket.key !== 'current' && item.ageing[bucket.key] > 0);
                return (
                  <li key={item.leaseId} className="space-y-3 px-5 py-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <Avatar name={item.tenant} tone={late ? 'danger' : 'warning'} />
                      <div className="min-w-0 flex-1 basis-44">
                        <p className="text-body font-semibold text-ink">{item.tenant}</p>
                        <p className="text-meta text-ink-muted">
                          <Link to={`/leases/${item.leaseId}`} className="font-medium text-ink underline underline-offset-2">
                            {item.unit}
                          </Link>
                          {' · '}{item.leaseRef}, oldest due {formatDate(item.oldestDueOn)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {item.proofPending ? <Badge tone="info">slip waiting</Badge> : null}
                        {stageText(item) ? (
                          <Badge tone={item.stage === 'letter_of_demand' && !item.pausedUntil ? 'danger' : item.pausedUntil ? 'neutral' : 'warning'}>
                            {stageText(item)}
                          </Badge>
                        ) : null}
                      </div>
                      <p className={`text-lead ${late ? 'text-danger' : 'text-ink'}`}><Money cents={item.totalCents} /></p>
                      <Button size="sm" variant="outline" aria-label={`Open the lease for ${item.unit}`} onClick={() => navigate(`/leases/${item.leaseId}`)}>
                        Open lease
                      </Button>
                    </div>
                    <div>
                      <div className="flex h-2.5 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
                        {BUCKETS.filter((bucket) => item.ageing[bucket.key] > 0).map((bucket) => (
                          <div key={bucket.key} className={BUCKET_BAR[bucket.key]} style={{ width: `${(item.ageing[bucket.key] / Math.max(1, item.totalCents)) * 100}%` }} />
                        ))}
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        {BUCKETS.filter((bucket) => item.ageing[bucket.key] > 0).map((bucket) => (
                          <span key={bucket.key} className="inline-flex items-center gap-1.5 text-meta text-ink-muted">
                            <span className={`h-2 w-2 rounded-full ${BUCKET_BAR[bucket.key]}`} aria-hidden />
                            {bucket.label}: <span className="text-ink">{zar(item.ageing[bucket.key])}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

const blank = {
  propertyId: '',
  unitId: '',
  category: 'repairs',
  description: '',
  amountCents: null as number | null,
  incurredOn: today(),
};

/** A slip that did not make it up: the expense is saved, and the same upload link can be tried again. */
interface PendingSlip { expenseId: string; uploadUrl: string; file: File }

function Expenses() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const options = periods();
  const [period, setPeriod] = useState(options[0]!.value);
  const range = options.find((option) => option.value === period)!;
  const list = useQuery({
    queryKey: ['expenses', range.from, range.to],
    queryFn: () => api.get<{ items: Expense[] }>(`/expenses?from=${range.from}&to=${range.to}`),
  });
  const properties = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ items: Property[] }>('/properties'),
  });

  const [editing, setEditing] = useState<{ id: string | null; form: typeof blank } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSlip, setPendingSlip] = useState<PendingSlip | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [removing, setRemoving] = useState<Expense | null>(null);

  const property = properties.data?.items.find((item) => item.id === editing?.form.propertyId);
  const ready = Boolean(editing && editing.form.description.trim().length >= 2 && (editing.form.amountCents ?? 0) > 0 && editing.form.incurredOn);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['expenses'] });
    await queryClient.invalidateQueries({ queryKey: ['report-income'] });
  };

  const close = () => {
    setEditing(null);
    setFile(null);
    setPendingSlip(null);
  };

  /** Sends the slip to its upload link, then has the server check it. 'dropped' can be retried. */
  const sendSlip = async (slip: PendingSlip): Promise<'ok' | 'dropped' | 'refused'> => {
    let uploaded: Response | null = null;
    try {
      uploaded = await fetch(slip.uploadUrl, { method: 'PUT', body: slip.file, headers: { 'content-type': slip.file.type } });
    } catch {
      uploaded = null;
    }
    if (!uploaded?.ok) return 'dropped';
    try {
      // The server checks the bytes and keeps its own copy. A refused slip is detached,
      // and the expense stays.
      await api.post(`/expenses/${slip.expenseId}/slip/confirm`, {});
      return 'ok';
    } catch (error) {
      toast.show({ title: 'Expense saved, slip refused', description: humanError(error), tone: 'warning' });
      return 'refused';
    }
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const body = {
        propertyId: editing.form.propertyId || null,
        unitId: editing.form.unitId || null,
        category: editing.form.category,
        description: editing.form.description.trim(),
        amountCents: editing.form.amountCents,
        incurredOn: editing.form.incurredOn,
      };
      // Set when the slip did not make it, so the warning is not followed by a plain "saved".
      let slipProblem = false;
      if (editing.id) {
        await api.put(`/expenses/${editing.id}`, body);
      } else {
        const created = await api.post<{ id: string; uploadUrl: string | null }>('/expenses', {
          ...body,
          slip: file ? { contentType: file.type, sizeBytes: file.size } : undefined,
        });
        // The expense exists now. Remember it, so a retry after a failed upload edits this one
        // rather than creating a second.
        setEditing({ id: created.id, form: editing.form });
        if (file && created.uploadUrl) {
          const slip = { expenseId: created.id, uploadUrl: created.uploadUrl, file };
          const outcome = await sendSlip(slip);
          if (outcome === 'dropped') {
            // The form stays open with the expense saved, so the slip can be tried again
            // without entering the expense a second time.
            toast.show({ title: 'Expense saved, slip not uploaded', tone: 'warning' });
            setPendingSlip(slip);
            await refresh();
            return;
          }
          if (outcome === 'refused') slipProblem = true;
        }
      }
      await refresh();
      // Saving an edit while the slip is still waiting keeps the form open for the retry.
      if (pendingSlip) {
        toast.show({ title: 'Expense saved', description: 'The slip is still not uploaded.', tone: 'warning' });
        return;
      }
      close();
      if (!slipProblem) toast.show({ title: 'Expense saved', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const retrySlip = async () => {
    if (!pendingSlip) return;
    setRetrying(true);
    try {
      const outcome = await sendSlip(pendingSlip);
      if (outcome === 'dropped') {
        toast.show({
          title: 'Slip still not uploaded',
          description: 'Check your connection and try again. The upload link works for a few minutes only.',
          tone: 'warning',
        });
        return;
      }
      await refresh();
      close();
      if (outcome === 'ok') toast.show({ title: 'Slip uploaded', tone: 'success' });
    } finally {
      setRetrying(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/expenses/${removing.id}`);
      await refresh();
      setRemoving(null);
      toast.show({ title: 'Expense deleted', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not deleted', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const items = list.data?.items ?? [];
  const total = items.reduce((sum, item) => sum + item.amountCents, 0);
  const byCategory = Object.entries(
    items.reduce<Record<string, number>>((sums, item) => ({ ...sums, [item.category]: (sums[item.category] ?? 0) + item.amountCents }), {}),
  ).sort((a, b) => b[1] - a[1]);
  const add = () => setEditing({ id: null, form: { ...blank, incurredOn: today() } });
  const edit = (form: NonNullable<typeof editing>['form']) => setEditing({ ...editing!, form });

  return (
    <div className="space-y-5">
      <Toolbar>
        <PeriodPicker id="expenses-period" value={period} onChange={setPeriod} options={options.map(({ value, label }) => ({ value, label }))} />
        <Button onClick={add}>Add expense</Button>
      </Toolbar>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} what="The expenses" />
      ) : list.isLoading ? (
        <Spinner />
      ) : !items.length ? (
        <EmptyState
          title="No expenses in this period"
          description="Add rates, levies, insurance and repairs as you pay them. They come off your rent in the income report."
          action={<Button variant="secondary" onClick={add}>Add the first expense</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4">
              <h2 className="text-lead font-bold text-ink">Expenses</h2>
              <p className="text-meta text-ink-muted">{items.length} {items.length === 1 ? 'expense' : 'expenses'}, {zar(total)} in all.</p>
            </div>
            <div className="hidden grid-cols-[6.5rem_minmax(0,1fr)_7.5rem_auto] gap-x-4 border-y border-line-soft bg-surface-muted px-5 py-2.5 text-meta font-semibold text-ink-muted md:grid" aria-hidden>
              <span>Date paid</span>
              <span>What it was for</span>
              <span className="text-right">Amount</span>
              <span className="w-[11.5rem]" />
            </div>
            <ul className="divide-y divide-line-soft border-t border-line-soft md:border-t-0">
              {items.map((expense) => (
                <li key={expense.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3.5 md:grid-cols-[6.5rem_minmax(0,1fr)_7.5rem_auto]">
                  <p className="order-2 col-span-2 text-meta text-ink-muted md:order-none md:col-span-1">{formatDate(expense.incurredOn)}</p>
                  <div className="order-1 min-w-0 md:order-none">
                    <p className="text-body font-semibold text-ink">{expense.description}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-ink-muted">
                      <Badge>{CATEGORIES[expense.category] ?? expense.category}</Badge>
                      {expense.property ? <span>{expense.property}{expense.unit ? ` ${expense.unit}` : ''}</span> : null}
                    </p>
                  </div>
                  <p className="order-1 text-right text-body text-ink md:order-none"><Money cents={expense.amountCents} /></p>
                  <div className="order-4 col-span-2 flex flex-wrap gap-2 md:order-none md:col-span-1 md:w-[11.5rem] md:justify-end">
                    {expense.slipKey ? (
                      <Button size="sm" variant="secondary" aria-label={`Slip for ${expense.description}`} onClick={() => openDocument(expense.slipKey!)}>Slip</Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Edit ${expense.description}`}
                      onClick={() =>
                        setEditing({
                          id: expense.id,
                          form: {
                            propertyId: expense.propertyId ?? '',
                            unitId: expense.unitId ?? '',
                            category: expense.category,
                            description: expense.description,
                            amountCents: expense.amountCents,
                            incurredOn: expense.incurredOn,
                          },
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" className="text-danger" aria-label={`Delete ${expense.description}`} onClick={() => setRemoving(expense)}>
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <aside className="space-y-5">
            <Tile label="Spent in this period" cents={total} note={`${formatDate(range.from)} to ${formatDate(range.to)}`} />
            <Card>
              <div className="px-5 py-4">
                <h2 className="text-lead font-bold text-ink">By category</h2>
                <ul className="mt-3 space-y-3">
                  {byCategory.map(([category, cents]) => (
                    <li key={category}>
                      <div className="flex items-baseline justify-between gap-3 text-meta">
                        <span className="text-ink">{CATEGORIES[category] ?? category}</span>
                        <span className="text-ink-muted">{zar(cents)}</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-200" aria-hidden>
                        <div className="h-full rounded-full bg-brand-400" style={{ width: `${share(cents, total)}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          </aside>
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={editing?.id ? 'Edit expense' : 'Add expense'}
        footer={
          editing ? (
            <>
              <Button variant="outline" onClick={close}>{pendingSlip ? 'Finish without the slip' : 'Cancel'}</Button>
              <Button loading={busy} disabled={!ready || retrying} onClick={save}>
                Save
              </Button>
            </>
          ) : undefined
        }
      >
        {editing ? (
          <div className="space-y-4">
            {pendingSlip ? (
              <Alert tone="warning" live="assertive" title="The expense is saved, but the slip did not upload">
                <p>Your connection may have dropped. Try the slip again now; the expense will not be entered twice.</p>
                <Button size="sm" variant="secondary" className="mt-2.5" loading={retrying} onClick={retrySlip}>
                  Try the slip again
                </Button>
              </Alert>
            ) : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Category" htmlFor="expense-category">
                <Select
                  id="expense-category"
                  value={editing.form.category}
                  onChange={(event) => edit({ ...editing.form, category: event.target.value })}
                  options={Object.entries(CATEGORIES).map(([value, label]) => ({ value, label }))}
                />
              </Field>
              <Field label="Date paid" htmlFor="expense-date">
                <Input
                  id="expense-date"
                  type="date"
                  value={editing.form.incurredOn}
                  onChange={(event) => edit({ ...editing.form, incurredOn: event.target.value })}
                />
              </Field>
              <Field label="Description" htmlFor="expense-description" className="sm:col-span-2">
                <Input
                  id="expense-description"
                  placeholder="What it was for"
                  maxLength={200}
                  value={editing.form.description}
                  onChange={(event) => edit({ ...editing.form, description: event.target.value })}
                />
              </Field>
              <Field label="Amount" htmlFor="expense-amount" className="sm:col-span-2">
                <CurrencyInput
                  key={editing.id ?? 'new'}
                  id="expense-amount"
                  cents={editing.form.amountCents}
                  onCentsChange={(cents) => edit({ ...editing.form, amountCents: cents })}
                />
              </Field>
              <Field label="Property" htmlFor="expense-property" className={property && property.units.some((unit) => unit.id) ? '' : 'sm:col-span-2'}>
                <Select
                  id="expense-property"
                  value={editing.form.propertyId}
                  onChange={(event) => edit({ ...editing.form, propertyId: event.target.value, unitId: '' })}
                  options={[
                    { value: '', label: 'Not tied to a property' },
                    ...(properties.data?.items ?? []).map((item) => ({ value: item.id, label: item.name })),
                  ]}
                />
              </Field>
              {property && property.units.some((unit) => unit.id) ? (
                <Field label="Unit" htmlFor="expense-unit">
                  <Select
                    id="expense-unit"
                    value={editing.form.unitId}
                    onChange={(event) => edit({ ...editing.form, unitId: event.target.value })}
                    options={[
                      { value: '', label: 'The whole property' },
                      ...property.units.filter((unit) => unit.id).map((unit) => ({ value: unit.id!, label: unit.code ?? '' })),
                    ]}
                  />
                </Field>
              ) : null}
            </div>
            {!editing.id ? (
              <Field label="Slip file" htmlFor="expense-slip" hint="Optional. A photo or PDF of the invoice or till slip.">
                <input
                  id="expense-slip"
                  type="file"
                  accept="image/jpeg,image/png,application/pdf"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  className="block w-full rounded-sm border border-dashed border-neutral-300 p-2 text-body text-ink-muted file:mr-3 file:rounded-sm file:border-0 file:bg-brand-50 file:px-3.5 file:py-2 file:text-meta file:font-semibold file:text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]"
                />
              </Field>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title="Delete this expense?"
        description={removing ? `"${removing.description}" comes off your reports, and its slip is deleted with it.` : ''}
        confirmLabel="Delete"
        loading={busy}
        onConfirm={remove}
      />
    </div>
  );
}
