import { query, withTransaction } from './db';
import { alert } from './alerts';
import { billingDriver } from './billing-driver';
import { logger } from './logger';
import { payfastConfig, updateSubscriptionAmount } from './payfast';
import { addMonth, subscriptionOf } from './subscription';
import { planById } from '../domain/plans';
import { addDaysIso, sastToday } from '../domain/dates';
import { company, vatIn } from '../domain/company';
import { zar } from '../domain/money';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * The invoice for a payment: numbered, dated, with the parties as they stand today, and the VAT
 * in it when the operator is registered. The owner is emailed; the PDF is made when opened.
 */
async function issueInvoice(
  run: Run,
  input: { landlordId: string; eventId: string; plan: { id: string; name: string }; amountCents: number; from: string; to: string; today: string },
) {
  const supplier = company();
  const [landlord] = await run<{ trading_name: string; email: string; registration_no: string | null; vat_no: string | null; owner: string | null }>(
    'select trading_name, email, registration_no, vat_no, cognito_sub as owner from landlord where id = $1',
    [input.landlordId],
  );
  const vat = vatIn(input.amountCents, Boolean(supplier.vatNo));
  const [invoice] = await run<{ number: string }>(
    `insert into billing_invoice (landlord_id, billing_event_id, issued_on, period_from, period_to, plan, amount_cents, vat_cents, supplier, recipient)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning number::text`,
    [
      input.landlordId, input.eventId, input.today, input.from, input.to, input.plan.id, input.amountCents, vat,
      JSON.stringify(supplier),
      JSON.stringify({ name: landlord!.trading_name, email: landlord!.email, registrationNo: landlord!.registration_no, vatNo: landlord!.vat_no }),
    ],
  );
  await run(
    `insert into notification (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
     values ($1, $2, 'email', 'account', 'billing_invoice', false, $3, $4)`,
    [
      landlord!.owner ?? `landlord:${input.landlordId}`,
      landlord!.email,
      `${supplier.vatNo ? 'Tax invoice' : 'Invoice'} ${invoice!.number} from ${supplier.name}: ${zar(input.amountCents)}`,
      `Thank you. We received ${zar(input.amountCents)} for ${supplier.name} ${input.plan.name}, ${input.from} to ${input.to}.\n\n` +
        `The invoice is under Settings, Plan, to download for your records.`,
    ],
  );
}

export interface PaymentNotice {
  provider: string;
  /** The provider's id for this payment, for ignoring a repeat. */
  externalId: string | null;
  /** Our checkout id, sent with the first payment and repeated on renewals. */
  checkoutId: string | null;
  /** The recurring payment's handle at the provider. */
  token: string | null;
  outcome: 'paid' | 'failed' | 'cancelled';
  amountCents: number | null;
  payload: Record<string, string>;
}

/** Records a notice that failed its checks, so a forged or broken one is still on file. */
export async function recordRejected(notice: Pick<PaymentNotice, 'provider' | 'externalId' | 'payload'>, problem: string) {
  await query(
    `insert into billing_event (provider, kind, external_id, verified, problem, payload) values ($1, 'rejected', $2, false, $3, $4)`,
    [notice.provider, notice.externalId, problem, JSON.stringify(notice.payload)],
  );
}

/**
 * Applies a verified payment notice to the landlord's subscription. A payment extends the paid
 * period by a month from where it ends (or the trial ends), or from today when it has run out; a failure marks the
 * account past due; a cancellation stops renewal but keeps the month already paid for.
 */
export async function applyPaymentNotice(notice: PaymentNotice): Promise<{ applied: boolean; problem?: string }> {
  const [checkout] = notice.checkoutId
    ? await query<{ id: string; landlord_id: string; plan: string; amount_cents: string }>(
        'select id, landlord_id, plan, amount_cents::text from billing_checkout where id::text = $1',
        [notice.checkoutId],
      )
    : [];
  const [byToken] = notice.token
    ? await query<{ landlord_id: string }>('select landlord_id from subscription where provider_token = $1', [notice.token])
    : [];
  const landlordId = byToken?.landlord_id ?? checkout?.landlord_id ?? null;
  if (!landlordId) {
    await recordRejected(notice, 'No checkout or subscription matches this payment.');
    return { applied: false, problem: 'unknown' };
  }

  const current = await subscriptionOf(landlordId);
  // A plan change waits until a payment at its price arrives; that payment applies it.
  const [pendingRow] = byToken
    ? await query<{ pending_plan: string | null }>('select pending_plan from subscription where landlord_id = $1', [landlordId])
    : [];
  const pending = planById(pendingRow?.pending_plan);
  const paysPending = Boolean(pending && notice.outcome === 'paid' && notice.amountCents === pending.priceCents);
  const plan = paysPending ? pending : planById(byToken ? current.plan : checkout?.plan) ?? planById(checkout?.plan);
  if (notice.outcome === 'paid') {
    const expected = new Set(
      [plan?.priceCents, pending?.priceCents, checkout ? Number(checkout.amount_cents) : undefined].filter((v) => v !== undefined),
    );
    if (notice.amountCents === null || !expected.has(notice.amountCents)) {
      await recordRejected(notice, `Amount ${notice.amountCents} is not what the plan costs.`);
      return { applied: false, problem: 'amount' };
    }
  }

  const today = sastToday();
  const result = await withTransaction(async (run) => {
    const inserted = await run<{ id: string }>(
      `insert into billing_event (landlord_id, provider, kind, external_id, verified, payload)
       values ($1, $2, $3, $4, true, $5)
       on conflict (provider, external_id) where external_id is not null and verified do nothing
       returning id`,
      [landlordId, notice.provider, notice.outcome, notice.externalId, JSON.stringify(notice.payload)],
    );
    if (inserted.length === 0) return { applied: false, problem: 'duplicate' };

    // The smaller plan was within its unit limit when asked for, but units added since may
    // put it over. Then it is not applied: the account stays on the plan it uses. This payment
    // still buys a full month of that plan at the smaller price; the shortfall is recorded on
    // the event and alerted, and the operator settles it by hand.
    let applyPlan = plan;
    let refused: string | null = null;
    if (paysPending && pending) {
      const [count] = await run<{ units: string }>(
        'select count(*)::text as units from unit u join property p on p.id = u.property_id where p.landlord_id = $1',
        [landlordId],
      );
      const kept = planById(current.plan);
      if (Number(count!.units) > pending.maxUnits && kept) {
        applyPlan = kept;
        refused =
          `Change to ${pending.name} not applied: ${count!.units} units, it covers ${pending.maxUnits}. ` +
          `Paid ${notice.amountCents}, ${kept.name} costs ${kept.priceCents}.`;
        await run('update billing_event set problem = $2 where id = $1', [inserted[0]!.id, refused]);
      }
    }

    if (notice.outcome === 'paid') {
      // Paying during the trial keeps the trial: the paid month starts when it ends.
      const from =
        current.status === 'trialing'
          ? (current.trialEndsOn >= today ? current.trialEndsOn : today)
          : current.currentPeriodEnd && current.currentPeriodEnd >= today
            ? current.currentPeriodEnd
            : today;
      const paidUntil = addMonth(from);
      await run(
        `update subscription set status = 'active', plan = $2, provider = $3,
                provider_token = coalesce($4, provider_token), current_period_end = $5, updated_at = now(),
                pending_plan = case when $6 then null else pending_plan end
          where landlord_id = $1`,
        [landlordId, applyPlan!.id, notice.provider, notice.token, paidUntil, paysPending],
      );
      await issueInvoice(run, {
        landlordId, eventId: inserted[0]!.id, plan: applyPlan!, amountCents: notice.amountCents!, from,
        // The last day covered: the next month starts on paidUntil, so periods never overlap.
        to: addDaysIso(paidUntil, -1), today,
      });
      if (checkout) await run('update billing_checkout set completed_at = coalesce(completed_at, now()) where id = $1', [checkout.id]);
    } else if (notice.outcome === 'failed') {
      // A declined card during the trial is not a missed payment: nothing was due yet. Marking it
      // past due locked the account at once, with weeks of trial left.
      await run(
        `update subscription set status = 'past_due', updated_at = now()
          where landlord_id = $1 and status not in ('cancelled', 'trialing')`,
        [landlordId],
      );
    } else {
      await run(`update subscription set status = 'cancelled', updated_at = now() where landlord_id = $1`, [landlordId]);
    }
    return { applied: true, refused, keptPriceCents: refused ? applyPlan!.priceCents : null };
  });

  if (result.refused) {
    // The monthly amount was lowered when the change was asked for; put it back.
    const token = notice.token ?? current.providerToken;
    try {
      if (billingDriver() === 'payfast' && token) {
        await updateSubscriptionAmount(payfastConfig(), token, result.keptPriceCents!);
      }
    } catch (error) {
      logger.error('Could not restore the subscription amount.', { landlordId, error });
    }
    await alert(`plan-downgrade-refused:${landlordId}`, 'A plan downgrade was refused', `Landlord ${landlordId}. ${result.refused}`);
  }
  return result.applied ? { applied: true } : { applied: false, problem: result.problem };
}
