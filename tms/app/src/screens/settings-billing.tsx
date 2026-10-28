import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Alert, Badge, Button, Card, CardBody, ConfirmDialog, PageHeader, useToast } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { SettingsNav } from '../components/settings-nav';
import { formatDate } from '../lib/format';
import { standingText, useBilling, type PlanId } from '../lib/billing';

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

  return (
    <main className="mx-auto max-w-3xl px-5 py-6">
      <PageHeader title="Settings" description="What you pay for Threshold." />
      <SettingsNav />

      {data.driver === 'off' ? (
        <Alert tone="info" title="Billing is off">This installation does not charge for use.</Alert>
      ) : (
        <>
          <Alert tone={tone} title={standingText(data)} className="mb-5">
            You have {data.units} {data.units === 1 ? 'unit' : 'units'}
            {data.allowance !== null && data.standing !== 'lapsed' ? `, and room for ${data.allowance}` : ''}. Tenants are never cut off,
            whatever the plan.
          </Alert>
          {returned && data.standing !== 'active' ? (
            <Alert tone="info" title="Waiting for PayFast to confirm the payment" className="mb-5">
              This page updates on its own. It usually takes a few seconds.{' '}
              <button type="button" className="font-bold text-brand-500" onClick={() => setParams({})}>Dismiss</button>
            </Alert>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {data.plans.map((plan) => {
              const current = data.plan === plan.id && data.standing !== 'lapsed' && data.standing !== 'trial';
              const tooSmall = data.units > plan.maxUnits;
              return (
                <Card key={plan.id} className={current ? 'border-ink' : ''}>
                  <CardBody className="flex h-full flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[15px] font-semibold">{plan.name}</p>
                      {current ? <Badge tone="success">Current</Badge> : data.recommended === plan.id ? <Badge tone="info">Fits you</Badge> : null}
                    </div>
                    <p className="font-display text-[26px] font-medium tabular-nums">
                      {formatZar(plan.priceCents / 100)}
                      <span className="ml-1 text-[13px] font-normal text-ink-muted">a month</span>
                    </p>
                    <p className="text-[13px] text-ink-muted">Up to {plan.maxUnits} units. Everything included.</p>
                    {data.isOwner ? (
                      <Button className="mt-auto" variant={current ? 'outline' : 'primary'} loading={busy === plan.id}
                        disabled={current || tooSmall || busy !== null} onClick={() => choose(plan.id)}>
                        {current ? 'Your plan' : tooSmall ? `Over ${plan.maxUnits} units` : data.hasRecurring && data.status !== 'cancelled' ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
                      </Button>
                    ) : null}
                  </CardBody>
                </Card>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-ink-muted">
            Prices include VAT. Paid monthly by card or instant EFT through PayFast; cancel any time and keep the month you paid for.
            More than 60 units? Get in touch.
          </p>
          {!data.isOwner ? <p className="mt-3 text-[13px] text-ink-muted">Only the account owner changes the plan.</p> : null}

          {data.isOwner && data.hasRecurring && data.status !== 'cancelled' ? (
            <button type="button" className="mt-5 text-[13px] font-bold text-danger" onClick={() => setCancelling(true)}>
              Cancel the plan
            </button>
          ) : null}

          {data.driver === 'local' && data.isOwner ? (
            <section aria-label="Simulated payments" className="mt-8 rounded-md border border-dashed border-line p-4">
              <p className="mb-1 text-[13px] font-semibold">Development: simulated PayFast</p>
              <p className="mb-3 text-xs text-ink-muted">No money moves. These take the same path a real PayFast notification does.</p>
              <div className="flex flex-wrap gap-2">
                {simulating ? (
                  <Button size="sm" loading={busy === 'paid'} onClick={() => simulate('paid', simulating)}>Pay the first month</Button>
                ) : null}
                {data.hasRecurring ? (
                  <>
                    <Button size="sm" variant="outline" loading={busy === 'paid'} onClick={() => simulate('paid')}>Next month paid</Button>
                    <Button size="sm" variant="outline" loading={busy === 'failed'} onClick={() => simulate('failed')}>Payment fails</Button>
                  </>
                ) : null}
                {!simulating && !data.hasRecurring ? <p className="text-xs text-ink-muted">Choose a plan to start a checkout.</p> : null}
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
    </main>
  );
}
