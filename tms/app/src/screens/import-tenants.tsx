import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, Checkbox, CurrencyInput, Input, PageHeader, SegmentedControl, Select, useToast,
} from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { localToday } from '../lib/dates';
import { PAGE } from '../lib/layout';

interface Unit { id: string; code: string; status: 'vacant' | 'held' | 'occupied' }
interface Property { id: string; name: string; units: Unit[] }

interface RowResult { line: number; tenant: string; unit: string; problems: string[]; newUnit?: boolean }
interface ImportResult { dryRun: boolean; results: RowResult[]; imported: number; failed: number; leaseIds?: string[] }

const TEMPLATE = [
  'Property,Unit,Bedrooms,Bathrooms,First name,Last name,Email,Phone,ID number,Lease start,Lease end,Rent,Escalation,Deposit held,Paid this month,Arrears,Arrears since',
  'Melville Gardens,G3,2,1,Thandi,Dlamini,thandi@example.co.za,082 123 4567,,2025-03-01,2027-02-28,7800,8,7800,yes,0,',
].join('\n');

const downloadTemplate = () => {
  const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'current-tenants.csv';
  link.click();
  URL.revokeObjectURL(url);
};

const blank = {
  unitId: '', firstName: '', lastName: '', email: '', phone: '', idNumber: '', startDate: '', endDate: '',
  monthlyRentCents: null as number | null, escalationPct: '', depositHeldCents: null as number | null,
  currentMonthPaid: 'yes' as 'yes' | 'no', owes: false, arrearsCents: null as number | null, arrearsSince: '',
};

/**
 * Tenants who were renting before the landlord used Threshold. One at a time from a form, or
 * many from a spreadsheet. Nothing is written until every row is right.
 */
export function ImportTenants() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'one' | 'sheet'>('one');
  const [invite, setInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(blank);
  const [problems, setProblems] = useState<string[]>([]);
  const [sheet, setSheet] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const { data: properties } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ items: Property[] }>('/properties'),
  });
  const freeUnits = useMemo(
    () =>
      (properties?.items ?? []).flatMap((property) =>
        property.units
          .filter((unit) => unit.status === 'vacant')
          .map((unit) => ({ value: unit.id, label: `${property.name} ${unit.code}` })),
      ),
    [properties],
  );
  const today = localToday();
  const monthStart = `${today.slice(0, 7)}-01`;

  const finished = async (count: number) => {
    setDone(count);
    await queryClient.invalidateQueries();
  };

  const addOne = async () => {
    setBusy(true);
    setProblems([]);
    try {
      const row = {
        unitId: form.unitId,
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        ...(form.idNumber.trim() ? { idNumber: form.idNumber } : {}),
        startDate: form.startDate,
        endDate: form.endDate,
        monthlyRentCents: form.monthlyRentCents ?? 0,
        escalationPct: Number(form.escalationPct || 0),
        depositHeldCents: form.depositHeldCents ?? 0,
        currentMonthPaid: form.currentMonthPaid === 'yes',
        arrearsCents: form.owes ? (form.arrearsCents ?? 0) : 0,
        ...(form.owes && form.arrearsSince ? { arrearsSince: form.arrearsSince } : {}),
      };
      const result = await api.post<ImportResult>('/leases/import', { rows: [row], dryRun: false, invite });
      if (result.failed > 0) setProblems(result.results[0]?.problems ?? []);
      else {
        toast.show({ title: `${form.firstName} ${form.lastName} added`, tone: 'success' });
        setForm(blank);
        await queryClient.invalidateQueries();
      }
    } catch (error) {
      toast.show({ title: 'Not added', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const check = async (file: File) => {
    const text = await file.text();
    setSheet({ name: file.name, text });
    setPreview(null);
    setBusy(true);
    try {
      setPreview(await api.post<ImportResult>('/leases/import', { csv: text, dryRun: true }));
    } catch (error) {
      toast.show({ title: 'Could not read the spreadsheet', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const importSheet = async () => {
    if (!sheet) return;
    setBusy(true);
    try {
      const result = await api.post<ImportResult>('/leases/import', { csv: sheet.text, dryRun: false, invite });
      if (result.failed > 0) setPreview(result);
      else await finished(result.imported);
    } catch (error) {
      toast.show({ title: 'Not imported', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const formReady =
    form.unitId && form.firstName.trim() && form.lastName.trim() && form.email.includes('@') && form.phone.trim() &&
    form.startDate && form.endDate && (form.monthlyRentCents ?? 0) > 0 && (!form.owes || ((form.arrearsCents ?? 0) > 0 && form.arrearsSince));

  const inviteBox = (
    <Checkbox
      id="import-invite"
      checked={invite}
      onChange={(event) => setInvite(event.target.checked)}
      label="Email each tenant a link to use the app"
    />
  );

  if (done !== null) {
    return (
      <main className={PAGE.narrow}>
        <PageHeader title="Current tenants" />
        <Alert tone="success" title={`${done} ${done === 1 ? 'tenancy' : 'tenancies'} added`}>
          This month's rent is on each lease, and the monthly run bills from next month as usual.{' '}
          {invite ? 'Each tenant has an email to start using the app. ' : ''}
          Anything overdue follows the arrears steps from tomorrow morning.
        </Alert>
        <div className="mt-4 flex gap-3">
          <Link to="/" className="font-bold text-brand-500">Back to the overview</Link>
          <button type="button" className="font-bold text-brand-500" onClick={() => { setDone(null); setSheet(null); setPreview(null); }}>
            Add more
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={PAGE.narrow}>
      <PageHeader title="Add current tenants" description="Tenancies that started before you used Threshold. No application or signing needed." />
      <SegmentedControl
        className="mb-5"
        options={[{ value: 'one', label: 'One tenant' }, { value: 'sheet', label: 'From a spreadsheet' }]}
        value={mode}
        onChange={setMode}
      />

      {mode === 'one' ? (
        <Card>
          <CardBody className="space-y-4">
            {freeUnits.length === 0 ? (
              <Alert tone="info" title="No empty units">
                Add the unit under <Link to="/properties" className="font-bold text-brand-500">Properties</Link> first.
              </Alert>
            ) : null}
            <Field label="Unit" htmlFor="imp-unit">
              <Select id="imp-unit" value={form.unitId} onChange={(event) => setForm({ ...form, unitId: event.target.value })}
                options={[{ value: '', label: 'Choose the unit' }, ...freeUnits]} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="First name" htmlFor="imp-first">
                <Input id="imp-first" value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} />
              </Field>
              <Field label="Last name" htmlFor="imp-last">
                <Input id="imp-last" value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} />
              </Field>
              <Field label="Email" htmlFor="imp-email">
                <Input id="imp-email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
              </Field>
              <Field label="Mobile" htmlFor="imp-phone">
                <Input id="imp-phone" type="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
              </Field>
            </div>
            <Field label="ID number" htmlFor="imp-id" hint="Optional. Only the last four digits are ever shown.">
              <Input id="imp-id" inputMode="numeric" value={form.idNumber} onChange={(event) => setForm({ ...form, idNumber: event.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Lease started" htmlFor="imp-start">
                <Input id="imp-start" type="date" max={today} value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} />
              </Field>
              <Field label="Lease ends" htmlFor="imp-end" hint="If it has run out and carries on month to month, use the original end date.">
                <Input id="imp-end" type="date" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} />
              </Field>
              <Field label="Rent now, a month" htmlFor="imp-rent">
                <CurrencyInput id="imp-rent" cents={form.monthlyRentCents} onCentsChange={(next) => setForm({ ...form, monthlyRentCents: next })} />
              </Field>
              <Field label="Yearly escalation" htmlFor="imp-esc" hint="Percent, on each lease anniversary.">
                <Input id="imp-esc" inputMode="decimal" value={form.escalationPct} placeholder="0"
                  onChange={(event) => setForm({ ...form, escalationPct: event.target.value.replace(/[^0-9.]/g, '') })} />
              </Field>
              <Field label="Deposit you hold" htmlFor="imp-dep">
                <CurrencyInput id="imp-dep" cents={form.depositHeldCents} onCentsChange={(next) => setForm({ ...form, depositHeldCents: next })} />
              </Field>
              <Field label="This month's rent" htmlFor="imp-paid">
                <Select id="imp-paid" value={form.currentMonthPaid}
                  onChange={(event) => setForm({ ...form, currentMonthPaid: event.target.value as 'yes' | 'no' })}
                  options={[{ value: 'yes', label: 'Paid' }, { value: 'no', label: 'Not paid yet' }]} />
              </Field>
            </div>
            <Checkbox id="imp-owes" checked={form.owes} onChange={(event) => setForm({ ...form, owes: event.target.checked })}
              label="They owe rent from before this month" />
            {form.owes ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Amount owed" htmlFor="imp-arrears">
                  <CurrencyInput id="imp-arrears" cents={form.arrearsCents} onCentsChange={(next) => setForm({ ...form, arrearsCents: next })} />
                </Field>
                <Field label="Owed since" htmlFor="imp-since" hint="The due date of the oldest unpaid rent.">
                  <Input id="imp-since" type="date" min={form.startDate || undefined} max={monthStart} value={form.arrearsSince}
                    onChange={(event) => setForm({ ...form, arrearsSince: event.target.value })} />
                </Field>
              </div>
            ) : null}
            {inviteBox}
            {problems.length > 0 ? (
              <Alert tone="warning" title="Fix these first">
                <ul className="list-disc pl-4">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
              </Alert>
            ) : null}
            <Button block loading={busy} disabled={!formReady} onClick={addOne}>Add tenancy</Button>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardBody className="space-y-3">
              <p className="text-[13.5px] text-ink">
                One row per tenancy. Properties must exist already; a unit that does not is added if you give its bedrooms and bathrooms.
                Dates as 2025-03-01 or 01/03/2025, amounts in rand.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={downloadTemplate}>Download the template</Button>
                <label className="cursor-pointer rounded-sm bg-action px-4 py-2 text-[14px] font-medium text-ink-inverse">
                  Choose the spreadsheet
                  <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="Spreadsheet"
                    onChange={(event) => { const file = event.target.files?.[0]; if (file) void check(file); event.target.value = ''; }} />
                </label>
                {sheet ? <span className="text-[13px] text-ink-muted">{sheet.name}</span> : null}
              </div>
              <p className="text-xs text-ink-muted">Save it from Excel or Google Sheets as CSV.</p>
            </CardBody>
          </Card>

          {preview ? (
            <section aria-label="Check">
              <h2 className="label mb-2">
                {preview.failed > 0
                  ? `${preview.failed} of ${preview.results.length} rows need fixing. Nothing is added until they all pass.`
                  : `${preview.results.length} ${preview.results.length === 1 ? 'tenancy' : 'tenancies'} ready`}
              </h2>
              <Card>
                <CardBody className="space-y-1">
                  {preview.results.map((row) => (
                    <div key={row.line} className="flex items-start justify-between gap-3 border-b border-line-soft py-2 last:border-0">
                      <div className="min-w-0">
                        <p className="text-[14px] font-semibold">
                          <span className="font-mono text-xs text-ink-muted">Row {row.line}</span> {row.tenant || 'No name'}
                        </p>
                        <p className="text-xs text-ink-muted">{row.unit}</p>
                        {row.problems.map((problem) => <p key={problem} className="text-xs text-danger">{problem}</p>)}
                      </div>
                      <Badge tone={row.problems.length ? 'danger' : row.newUnit ? 'info' : 'success'}>
                        {row.problems.length ? 'Fix' : row.newUnit ? 'Adds unit' : 'Ready'}
                      </Badge>
                    </div>
                  ))}
                </CardBody>
              </Card>
              {preview.failed === 0 ? (
                <div className="mt-4 space-y-3">
                  {inviteBox}
                  <Button loading={busy} onClick={importSheet}>
                    Add {preview.results.length} {preview.results.length === 1 ? 'tenancy' : 'tenancies'}
                  </Button>
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-ink-muted">Fix the rows in your spreadsheet and choose it again.</p>
              )}
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
