import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Badge, Button, Card, CardBody, CurrencyInput, EmptyState, Input, Modal, PageHeader, Select, Spinner, Tabs, useToast,
} from '@hlonie/toolbox/ui';
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
    <main className={PAGE.medium}>
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

function IncomeExpense() {
  const options = periods();
  const [period, setPeriod] = useState(options[0]!.value);
  const range = options.find((option) => option.value === period)!;
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['report-income', range.from, range.to],
    queryFn: () => api.get<IncomeReport>(`/reports/income-expense?from=${range.from}&to=${range.to}`),
  });

  const used = data
    ? Object.keys(CATEGORIES).filter((category) => (data.totals.expenseCents[category] ?? 0) > 0)
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="min-w-0 flex-1"
          aria-label="Period"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          options={options.map(({ value, label }) => ({ value, label }))}
        />
        <Button variant="outline" disabled={!data} onClick={exportCsv}>Download CSV</Button>
      </div>
      {isError ? (
        <QueryError error={error} onRetry={() => void refetch()} what="The report" />
      ) : isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <Ledger rows={data.items.filter(active)} totals={data.totals} />
          {data.items.some((row) => !active(row)) ? (
            <p className="text-xs text-ink-muted">
              {data.items.filter((row) => !active(row)).length === 1
                ? '1 property with no rent or expenses in this period is hidden here and included in the CSV.'
                : `${data.items.filter((row) => !active(row)).length} properties with no rent or expenses in this period are hidden here and included in the CSV.`}
            </p>
          ) : null}
          <p className="text-xs text-ink-muted">
            Net is rent collected less expenses, the cash view SARS starts from. Deposits are not income
            and are left out. Bond capital is not deductible; record only the interest.
          </p>
        </>
      )}
    </div>
  );
}

const active = (row: IncomeRow) => row.invoicedCents > 0 || row.collectedCents > 0 || row.expensesCents > 0;

/**
 * Income and expenses as one statement: each property a group of ruled lines, its net on the
 * heading row, and the period's totals under a double rule at the foot.
 */
function Ledger({ rows, totals }: { rows: IncomeRow[]; totals: IncomeRow }) {
  return (
    <table className="w-full border-y border-line text-meta">
      <caption className="sr-only">Income and expenses by property</caption>
      <thead className="sr-only">
        <tr><th scope="col">Item</th><th scope="col">Amount</th></tr>
      </thead>
      {rows.map((row) => (
        <tbody key={row.propertyId ?? 'none'} className="border-b border-line">
          <tr>
            <th scope="rowgroup" className="pb-1 pt-4 text-left text-lead font-semibold text-ink">{row.property}</th>
            <td className={`pb-1 pt-4 text-right text-lead ${row.netCents < 0 ? 'text-danger' : ''}`}>
              <Money cents={row.netCents} className="font-semibold" />
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
        <Line label="Rent invoiced" cents={totals.invoicedCents} first />
        <Line label="Rent collected" cents={totals.collectedCents} />
        <Line label="Expenses" cents={-totals.expensesCents} />
        <tr className="border-t-4 border-double border-line">
          <th scope="row" className="py-3 text-left text-lead font-semibold text-ink">Net for the period</th>
          <td className={`py-3 text-right text-figure ${totals.netCents < 0 ? 'text-danger' : ''}`}>
            <Money cents={totals.netCents} className="font-semibold" />
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function Line({ label, cents, hint, first }: { label: string; cents: number; hint?: string; first?: boolean }) {
  const pad = first ? 'pb-1 pt-4' : 'py-1';
  return (
    <tr>
      <th scope="row" className={`${pad} text-left font-normal text-ink-muted`}>
        {label}
        {hint ? <span className="ml-1 text-xs">({hint})</span> : null}
      </th>
      <td className={`${pad} text-right`}><Money cents={cents} className="text-ink" /></td>
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

function Arrears() {
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-body text-ink">
          {data.totals.totalCents > 0 ? <>{zar(data.totals.totalCents)} owed across {data.items.length} {data.items.length === 1 ? 'lease' : 'leases'}.</> : 'Nobody owes anything.'}
        </p>
        <Button variant="outline" disabled={data.items.length === 0} onClick={exportCsv}>Download CSV</Button>
      </div>
      <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-5">
        {BUCKETS.map((bucket) => (
          <div key={bucket.key} className="border-line py-3 sm:border-l sm:px-4 sm:first:border-l-0 sm:first:pl-0">
            <dt className="text-xs text-ink-muted">{bucket.label}</dt>
            <dd className="text-figure"><Money cents={data.totals.ageing[bucket.key]} whole /></dd>
          </div>
        ))}
      </dl>
      {data.items.length === 0 ? (
        <EmptyState title="No arrears" description="Every invoice is paid." />
      ) : (
        data.items.map((item) => (
          <Card key={item.leaseId}>
            <CardBody className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link to={`/leases/${item.leaseId}`} className="text-lead font-semibold text-ink underline">
                    {item.unit}
                  </Link>
                  <p className="text-xs text-ink-muted">
                    {item.tenant}, {item.leaseRef}, oldest due {formatDate(item.oldestDueOn)}
                  </p>
                  {stageText(item) ? (
                    <p className={`text-xs ${item.stage === 'letter_of_demand' ? 'font-semibold text-danger' : 'text-ink-muted'}`}>
                      {stageText(item)}
                    </p>
                  ) : null}
                </div>
                <div className="text-right">
                  <p className="text-lead"><Money cents={item.totalCents} className="font-semibold" /></p>
                  {item.proofPending ? <Badge tone="info">slip waiting</Badge> : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {BUCKETS.filter((bucket) => item.ageing[bucket.key] > 0).map((bucket) => (
                  <span key={bucket.key} className="text-xs text-ink-muted">
                    {bucket.label}: <span className="tabular-nums">{zar(item.ageing[bucket.key])}</span>
                  </span>
                ))}
              </div>
            </CardBody>
          </Card>
        ))
      )}
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

  const property = properties.data?.items.find((item) => item.id === editing?.form.propertyId);
  const ready = Boolean(editing && editing.form.description.trim().length >= 2 && (editing.form.amountCents ?? 0) > 0 && editing.form.incurredOn);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['expenses'] });
    await queryClient.invalidateQueries({ queryKey: ['report-income'] });
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
      if (editing.id) {
        await api.put(`/expenses/${editing.id}`, body);
      } else {
        const created = await api.post<{ id: string; uploadUrl: string | null }>('/expenses', {
          ...body,
          slip: file ? { contentType: file.type, sizeBytes: file.size } : undefined,
        });
        if (file && created.uploadUrl) {
          const uploaded = await fetch(created.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
          if (!uploaded.ok) {
            toast.show({ title: 'Expense saved, slip not uploaded', tone: 'warning' });
          } else {
            // The server checks the bytes and keeps its own copy. A refused slip is detached,
            // and the expense stays.
            await api.post(`/expenses/${created.id}/slip/confirm`, {}).catch((error) =>
              toast.show({ title: 'Expense saved, slip refused', description: humanError(error), tone: 'warning' }),
            );
          }
        }
      }
      await refresh();
      setEditing(null);
      setFile(null);
      toast.show({ title: 'Expense saved', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (expense: Expense) => {
    if (!window.confirm(`Delete "${expense.description}"?`)) return;
    try {
      await api.delete(`/expenses/${expense.id}`);
      await refresh();
    } catch (error) {
      toast.show({ title: 'Not deleted', description: humanError(error), tone: 'danger' });
    }
  };

  const total = list.data?.items.reduce((sum, item) => sum + item.amountCents, 0) ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="min-w-0 flex-1"
          aria-label="Period"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          options={options.map(({ value, label }) => ({ value, label }))}
        />
        <Button onClick={() => setEditing({ id: null, form: { ...blank, incurredOn: today() } })}>Add expense</Button>
      </div>
      {list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} what="The expenses" />
      ) : list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <EmptyState title="No expenses in this period" description="Add rates, levies, insurance and repairs as you pay them." />
      ) : (
        <>
          <p className="text-meta text-ink-muted">{list.data.items.length} expenses, {zar(total)} in all.</p>
          {list.data.items.map((expense) => (
            <Card key={expense.id}>
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-body font-semibold text-ink">{expense.description}</p>
                  <p className="text-xs text-ink-muted">
                    {formatDate(expense.incurredOn)}, {CATEGORIES[expense.category] ?? expense.category}
                    {expense.property ? `, ${expense.property}${expense.unit ? ` ${expense.unit}` : ''}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Money cents={expense.amountCents} className="text-body" />
                  {expense.slipKey ? (
                    <Button variant="ghost" onClick={() => openDocument(expense.slipKey!)}>Slip</Button>
                  ) : null}
                  <Button
                    variant="ghost"
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
                  <Button variant="ghost" onClick={() => remove(expense)}>Delete</Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </>
      )}

      <Modal
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setFile(null);
          }
        }}
        title={editing?.id ? 'Edit expense' : 'Add expense'}
      >
        {editing ? (
          <div className="space-y-3">
            <Select
              aria-label="Category"
              value={editing.form.category}
              onChange={(event) => setEditing({ ...editing, form: { ...editing.form, category: event.target.value } })}
              options={Object.entries(CATEGORIES).map(([value, label]) => ({ value, label }))}
            />
            <Input
              placeholder="What it was for"
              maxLength={200}
              value={editing.form.description}
              onChange={(event) => setEditing({ ...editing, form: { ...editing.form, description: event.target.value } })}
            />
            <CurrencyInput
              key={editing.id ?? 'new'}
              aria-label="Amount"
              cents={editing.form.amountCents}
              onCentsChange={(cents) => setEditing({ ...editing, form: { ...editing.form, amountCents: cents } })}
            />
            <Input
              type="date"
              aria-label="Date paid"
              value={editing.form.incurredOn}
              onChange={(event) => setEditing({ ...editing, form: { ...editing.form, incurredOn: event.target.value } })}
            />
            <Select
              aria-label="Property"
              value={editing.form.propertyId}
              onChange={(event) =>
                setEditing({ ...editing, form: { ...editing.form, propertyId: event.target.value, unitId: '' } })
              }
              options={[
                { value: '', label: 'Not tied to a property' },
                ...(properties.data?.items ?? []).map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            {property && property.units.some((unit) => unit.id) ? (
              <Select
                aria-label="Unit"
                value={editing.form.unitId}
                onChange={(event) => setEditing({ ...editing, form: { ...editing.form, unitId: event.target.value } })}
                options={[
                  { value: '', label: 'The whole property' },
                  ...property.units.filter((unit) => unit.id).map((unit) => ({ value: unit.id!, label: unit.code ?? '' })),
                ]}
              />
            ) : null}
            {!editing.id ? (
              <input
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                aria-label="Slip file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="block w-full text-body text-ink-muted file:mr-3 file:rounded-sm file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-body file:font-semibold file:text-brand-500"
              />
            ) : null}
            <Button block loading={busy} disabled={!ready} onClick={save}>
              Save
            </Button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
