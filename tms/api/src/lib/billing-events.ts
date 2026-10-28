import { query, withTransaction } from './db';
import { addMonth, subscriptionOf } from './subscription';
import { planById } from '../domain/plans';
import { sastToday } from '../domain/dates';

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
  const plan = planById(byToken ? current.plan : checkout?.plan) ?? planById(checkout?.plan);
  if (notice.outcome === 'paid') {
    const expected = new Set([plan?.priceCents, checkout ? Number(checkout.amount_cents) : undefined].filter((v) => v !== undefined));
    if (notice.amountCents === null || !expected.has(notice.amountCents)) {
      await recordRejected(notice, `Amount ${notice.amountCents} is not what the plan costs.`);
      return { applied: false, problem: 'amount' };
    }
  }

  const today = sastToday();
  return withTransaction(async (run) => {
    const inserted = await run(
      `insert into billing_event (landlord_id, provider, kind, external_id, verified, payload)
       values ($1, $2, $3, $4, true, $5)
       on conflict (provider, external_id) where external_id is not null and verified do nothing
       returning id`,
      [landlordId, notice.provider, notice.outcome, notice.externalId, JSON.stringify(notice.payload)],
    );
    if (inserted.length === 0) return { applied: false, problem: 'duplicate' };

    if (notice.outcome === 'paid') {
      // Paying during the trial keeps the trial: the paid month starts when it ends.
      const from =
        current.status === 'trialing'
          ? (current.trialEndsOn >= today ? current.trialEndsOn : today)
          : current.currentPeriodEnd && current.currentPeriodEnd >= today
            ? current.currentPeriodEnd
            : today;
      await run(
        `update subscription set status = 'active', plan = $2, provider = $3,
                provider_token = coalesce($4, provider_token), current_period_end = $5, updated_at = now()
          where landlord_id = $1`,
        [landlordId, plan!.id, notice.provider, notice.token, addMonth(from)],
      );
      if (checkout) await run('update billing_checkout set completed_at = coalesce(completed_at, now()) where id = $1', [checkout.id]);
    } else if (notice.outcome === 'failed') {
      await run(`update subscription set status = 'past_due', updated_at = now() where landlord_id = $1 and status <> 'cancelled'`, [landlordId]);
    } else {
      await run(`update subscription set status = 'cancelled', updated_at = now() where landlord_id = $1`, [landlordId]);
    }
    return { applied: true };
  });
}
