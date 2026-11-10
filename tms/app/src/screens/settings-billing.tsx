import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, ConfirmDialog, useToast } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { SettingsLayout } from '../components/settings-nav';
import { formatDate } from '../lib/format';
import { useOpenDocument } from '../lib/open-document';
import { standingText, useBilling, type PlanId } from '../lib/billing';
import { Money } from '../components/money';

/** Posts the signed PayFast form from the browser: the card details never touch this server. */
function postToPayfast(action: string, fields: Record<string, string>) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

interface BillingInvoice {
  id: string;
  number: string;
  issuedOn: string;
  periodFrom: string;
  periodTo: string;
  plan: string;
  amountCents: number;
  vatCents: number;
}

/** Every payment to Threshold has its own numbered invoice, a tax invoice once we charge VAT. */
function Invoices() {
  const open = useOpenDocument();
  const { data } = useQuery({
    queryKey: ['billing', 'invoices'],
    queryFn: () => api.get<{ items: BillingInvoice[] }>('/billing/invoices'),
  });
  if (!data || data.items.length === 0) return null;
  return (
    <section aria-label="Invoices">
      <Card>
        <div className="px-5 py-4">
          <h2 className="text-lead font-bold text-ink">Invoices</h2>
          <p className="text-meta text-ink-muted">One for every payment to Threshold.</p>
        </div>
        <ul className="divide-y divide-line-soft border-t border-line-soft">
          {data.items.map((invoice) => (
            <li key={invoice.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold text-ink">Invoice {invoice.number}</p>
                <p className="text-meta text-ink-muted">
                  {formatDate(invoice.periodFrom)} to {formatDate(invoice.periodTo)}
                  {invoice.vatCents > 0 ? `, VAT ${formatZar(invoice.vatCents / 100)}` : ''}
                </p>
              </div>
              <Money cents={invoice.amountCents} className="text-body text-ink" />
              <Button size="sm" variant="outline" aria-label={`PDF of invoice ${invoice.number}`}
                onClick={() => open(async () => (await api.post<{ key: string }>(`/billing/invoices/${invoice.id}/render`, {})).key)}>
                PDF
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

export function SettingsBilling() {
  const { data, isLoading, isError, error, refetch } = useBilling();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [simulating, setSimulating] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const returned = params.get('paid') === '1';

  // Back from PayFast: the notification may land a few seconds after the browser does.
  useEffect(() => {
    if (!returned) return;
    const timer = setInterval(() => void refetch(), 3000);
    const stop = setTimeout(() => clearInterval(timer), 60_000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [returned, refetch]);

  if (!data) return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your plan" />;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['billing'] });
    await queryClient.invalidateQueries({ queryKey: ['landlord'] });
  };

  const choose = async (plan: PlanId) => {
    setBusy(plan);
    try {
      if (data.hasRecurring && data.status !== 'cancelled') {
        await api.post('/billing/plan', { action: 'change', plan });
        toast.show({ title: 'Plan changed', description: 'The new price applies from the next payment.', tone: 'success' });
        await refresh();
        return;
      }
      const checkout = await api.post<{ kind: 'simulate'; checkoutId: string } | { kind: 'redirect'; action: string; fields: Record<string, string> }>(
        '/billing/checkout',
        { plan },
      );
      if (checkout.kind === 'redirect') postToPayfast(checkout.action, checkout.fields);
      else setSimulating(checkout.checkoutId);
    } catch (failure) {
      toast.show({ title: 'That did not work', description: humanError(failure), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const simulate = async (outcome: 'paid' | 'failed', checkoutId?: string) => {
    setBusy(outcome);
    try {
      await api.post('/billing/simulate', { outcome, ...(checkoutId ? { checkoutId } : {}) });
      setSimulating(null);
      await refresh();
    } catch (failure) {
      toast.show({ title: 'Simulation failed', description: humanError(failure), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    try {
      await api.post('/billing/plan', { action: 'cancel' });
      setCancelling(false);
      toast.show({ title: 'Plan cancelled', description: `It runs until ${formatDate(data.paidUntil)}.`, tone: 'success' });
      await refresh();
    } catch (failure) {
      toast.show({ title: 'Not cancelled', description: humanError(failure), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const tone = data.standing === 'lapsed' ? 'danger' : data.standing === 'past_due' ? 'warning' : 'info';

  // One green button on the page: the plan that fits when there is none yet, otherwise none
  // stands out more than another and switching is an outline button.
  const hasPlan = data.plans.some((plan) => data.plan === plan.id && data.standing !== 'lapsed' && data.standing !== 'trial');
  const lead = hasPlan ? null : (data.recommended ?? data.plans.find((plan) => data.units <= plan.maxUnits)?.id ?? null);

  return (
    <SettingsLayout description="What you pay for Threshold.">
      {data.driver === 'off' ? (
        <Alert tone="info" title="Billing is off">This installation does not charge for use.</Alert>
      ) : (
        <>
          <Alert tone={tone} title={standingText(data)}>
            You have {data.units} {data.units === 1 ? 'unit' : 'units'}
            {data.allowance !== null && data.standing !== 'lapsed' ? `, and room for ${data.allowance}` : ''}. Tenants are never cut off,
            whatever the plan.
          </Alert>
          {returned && data.standing !== 'active' ? (
            <Alert tone="info" title="Waiting for PayFast to confirm the payment">
              <p>This page updates on its own. It usually takes a few seconds.</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setParams({})}>Dismiss</Button>
            </Alert>
          ) : null}

          <section aria-label="Plans">
            <h2 className="mb-3 text-lead font-bold text-ink">Plans</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {data.plans.map((plan) => {
                const current = data.plan === plan.id && data.standing !== 'lapsed' && data.standing !== 'trial';
                const tooSmall = data.units > plan.maxUnits;
                return (
                  <Card key={plan.id} className={current ? 'border-2 border-brand-500' : ''}>
                    <div className="flex h-full flex-col gap-3 p-5">
                      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
                        <p className="text-lead font-bold text-ink">{plan.name}</p>
                        {current ? <Badge tone="success">Current</Badge> : data.pendingPlan === plan.id ? <Badge tone="info">From your next payment</Badge> : data.recommended === plan.id ? <Badge tone="info">Fits you</Badge> : null}
                      </div>
                      <p className="font-display text-figure font-bold text-ink">
                        <Money whole cents={plan.priceCents} />
                        <span className="ml-1.5 text-meta font-normal tracking-normal text-ink-muted">a month</span>
                      </p>
                      <p className="text-meta text-ink-muted">Up to {plan.maxUnits} units. Everything included.</p>
                      {data.isOwner ? (
                        <Button block className="mt-auto" variant={lead === plan.id ? 'primary' : 'outline'} loading={busy === plan.id}
                          disabled={current || tooSmall || busy !== null} onClick={() => choose(plan.id)}>
                          {current ? 'Your plan' : tooSmall ? `Over ${plan.maxUnits} units` : data.hasRecurring && data.status !== 'cancelled' ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
                        </Button>
                      ) : null}
                    </div>
                  </Card>
                );
              })}
            </div>
            <p className="mt-3 text-meta text-ink-muted">
              Prices include VAT. Paid monthly by card or instant EFT through PayFast; cancel any time and keep the month you paid for.
              More than 60 units? Get in touch.
            </p>
            {!data.isOwner ? <p className="mt-2 text-meta text-ink-muted">Only the account owner changes the plan.</p> : null}
          </section>

          <Invoices />

          {data.isOwner && data.hasRecurring && data.status !== 'cancelled' ? (
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <h2 className="text-lead font-bold text-ink">Stop paying</h2>
                  <p className="text-meta text-ink-muted">You keep the month you paid for. Tenants are never cut off.</p>
                </div>
                <Button variant="outline" className="text-danger" onClick={() => setCancelling(true)}>
                  Cancel the plan
                </Button>
              </div>
            </Card>
          ) : null}

          {data.driver === 'local' && data.isOwner ? (
            <section aria-label="Simulated payments" className="rounded-md border border-dashed border-neutral-300 px-5 py-4">
              <h2 className="text-body font-bold text-ink">Development: simulated PayFast</h2>
              <p className="mb-3 text-meta text-ink-muted">No money moves. These take the same path a real PayFast notification does.</p>
              <div className="flex flex-wrap items-center gap-2">
                {simulating ? (
                  <Button size="sm" variant="secondary" loading={busy === 'paid'} onClick={() => simulate('paid', simulating)}>Pay the first month</Button>
                ) : null}
                {data.hasRecurring ? (
                  <>
                    <Button size="sm" variant="outline" loading={busy === 'paid'} onClick={() => simulate('paid')}>Next month paid</Button>
                    <Button size="sm" variant="outline" loading={busy === 'failed'} onClick={() => simulate('failed')}>Payment fails</Button>
                  </>
                ) : null}
                {!simulating && !data.hasRecurring ? <p className="text-meta text-ink-muted">Choose a plan to start a checkout.</p> : null}
              </div>
            </section>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel the plan?"
        description={`No more payments are taken. Everything keeps working until ${formatDate(data.paidUntil)}; after that you can see your data but not change it.`}
        confirmLabel="Cancel the plan"
        loading={busy === 'cancel'}
        onConfirm={cancel}
      />
    </SettingsLayout>
  );
}
