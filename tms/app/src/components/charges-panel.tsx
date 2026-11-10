import { useState } from 'react';
import { Badge, Button, ConfirmDialog, CurrencyInput, Input, Modal, Select, useToast } from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { localToday } from '../lib/dates';
import { formatMonth } from '../lib/format';
import { Money } from './money';
import { ROW, ROWS, SectionCard } from './core-kit';

export interface Charge {
  id: string;
  period: string;
  kind: 'utility' | 'other';
  description: string;
  amountCents: number;
  billed: boolean;
}

const SUGGESTIONS = ['Water', 'Electricity', 'Water and electricity', 'Levy', 'Refuse removal', 'Sewerage'];

/** The months a charge can go on: the last few, this one, and up to three ahead. */
function months(): { value: string; label: string }[] {
  const today = localToday();
  const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 + 3 - index, 1));
    const value = date.toISOString().slice(0, 7);
    return { value, label: formatMonth(value) };
  });
}

/**
 * Water, electricity, levies and other charges on top of rent. A charge goes on its month's
 * invoice while that is not due yet, else on the next one; the tenant is told once it is on one.
 */
export function ChargesPanel({ leaseId, charges, landlord, onChanged }: {
  leaseId: string;
  charges: Charge[];
  landlord: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const options = months();
  const blank = { period: localToday().slice(0, 7), kind: 'utility' as 'utility' | 'other', description: '', amountCents: null as number | null };
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  // Removing a charge changes what the tenant owes, so it asks first.
  const [removing, setRemoving] = useState<Charge | null>(null);

  if (!landlord && charges.length === 0) return null;

  const act = async <T,>(fn: () => Promise<T>, message: string | ((result: T) => string)) => {
    setBusy(true);
    try {
      const result = await fn();
      toast.show({ title: typeof message === 'function' ? message(result) : message, tone: 'success' });
      onChanged();
      return true;
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionCard
        title="Charges on top of rent"
        label="Charges"
        action={
          landlord ? (
            <Button size="sm" variant="secondary" onClick={() => { setForm(blank); setAdding(true); }}>
              Add a charge
            </Button>
          ) : null
        }
      >
        {charges.length === 0 ? (
          <p className="px-5 py-4 text-meta text-ink-muted">
            None yet. Add water, electricity or levies here and they go on the tenant's invoice.
          </p>
        ) : (
          <ul className={ROWS}>
            {charges.map((charge) => (
              <li key={charge.id} className={ROW}>
                <div className="min-w-0">
                  <p className="truncate text-body font-bold text-ink">{charge.description}</p>
                  <p className="text-meta text-ink-muted">{formatMonth(charge.period)}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                  <Money cents={charge.amountCents} className="text-body" />
                  <Badge tone={charge.billed ? 'neutral' : 'info'}>{charge.billed ? 'Invoiced' : 'Next invoice'}</Badge>
                  {landlord ? (
                    <Button size="sm" variant="outline" disabled={busy}
                      aria-label={`Remove ${charge.description} for ${formatMonth(charge.period)}`}
                      onClick={() => setRemoving(charge)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => { if (!next && !busy) setRemoving(null); }}
        title="Remove this charge?"
        description={
          removing
            ? `${removing.description} for ${formatMonth(removing.period)} comes off ${
                removing.billed ? 'the invoice it is on, and the tenant owes that much less' : 'the next invoice'
              }.`
            : ''
        }
        confirmLabel="Remove the charge"
        loading={busy}
        onConfirm={async () => {
          if (!removing || busy) return;
          await act(() => api.delete(`/leases/${leaseId}/charges/${removing.id}`), 'Charge removed');
          setRemoving(null);
        }}
      >
        {removing ? <Money cents={removing.amountCents} className="text-title text-ink" /> : null}
      </ConfirmDialog>

      <Modal open={adding} onOpenChange={setAdding} title="Add a charge"
        description="It goes on that month's invoice if it is not due yet, or else on the next one, so it is never overdue the day it is added.">
        <div className="space-y-3">
          <Field label="Month" htmlFor="charge-month">
            <Select id="charge-month" value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value })} options={options} />
          </Field>
          <Field label="What for" htmlFor="charge-what">
            <Input id="charge-what" list="charge-suggestions" value={form.description} maxLength={120}
              onChange={(event) => setForm({ ...form, description: event.target.value })} />
            <datalist id="charge-suggestions">{SUGGESTIONS.map((item) => <option key={item} value={item} />)}</datalist>
          </Field>
          <Field label="Kind" htmlFor="charge-kind">
            <Select id="charge-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as 'utility' | 'other' })}
              options={[{ value: 'utility', label: 'Utility: water, electricity, refuse' }, { value: 'other', label: 'Other: levy, key, repair caused by the tenant' }]} />
          </Field>
          <Field label="Amount" htmlFor="charge-amount">
            <CurrencyInput id="charge-amount" cents={form.amountCents} onCentsChange={(next) => setForm({ ...form, amountCents: next })} />
          </Field>
          <Button block loading={busy} disabled={form.description.trim().length < 3 || !form.amountCents}
            onClick={async () => {
              const done = await act(
                () =>
                  api.post<{ billed: boolean; onMonth: string }>(`/leases/${leaseId}/charges`, {
                    ...form,
                    description: form.description.trim(),
                    amountCents: form.amountCents,
                  }),
                (result) => `${form.description.trim()} goes on the ${formatMonth(result.onMonth)} invoice`,
              );
              if (done) setAdding(false);
            }}>
            Add charge
          </Button>
        </div>
      </Modal>
    </>
  );
}
