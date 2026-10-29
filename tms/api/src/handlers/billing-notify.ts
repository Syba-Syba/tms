import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { applyPaymentNotice, recordRejected, type PaymentNotice } from '../lib/billing-events';
import { billingDriver } from '../lib/billing-driver';
import { logger } from '../lib/logger';
import { confirmedByPayfast, fromPayfast, itnSignatureValid, parseItn, payfastConfig } from '../lib/payfast';

const ok = (): APIGatewayProxyResultV2 => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'OK' });

const OUTCOMES: Record<string, PaymentNotice['outcome']> = { COMPLETE: 'paid', FAILED: 'failed', CANCELLED: 'cancelled' };

/**
 * PayFast's instant transaction notification. No sign-in: it comes from PayFast's servers. It
 * is trusted only after four checks: the signature, the sender's address, PayFast confirming
 * the data, and (when applied) the amount. PayFast always gets a 200, or it retries; anything
 * that fails a check is kept on file with the reason.
 */
export const handler = async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (billingDriver() !== 'payfast') return { statusCode: 404, body: 'Not found' };
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  const fields = parseItn(raw);
  const data = Object.fromEntries(fields);
  const base = { provider: 'payfast', externalId: data.pf_payment_id ?? null, payload: data };
  const config = payfastConfig();
  const ip = event.requestContext.http?.sourceIp ?? '';

  try {
    if (!itnSignatureValid(fields, config.passphrase)) {
      await recordRejected(base, 'Signature does not match.');
      return ok();
    }
    // A valid notification for someone else's PayFast account must not pay for ours.
    if (data.merchant_id !== config.merchantId) {
      await recordRejected(base, `Paid to merchant ${data.merchant_id ?? 'unknown'}, not ours.`);
      return ok();
    }
    if (!(await fromPayfast(ip))) {
      await recordRejected(base, `Sent from ${ip}, not a PayFast server.`);
      return ok();
    }
    if (!(await confirmedByPayfast(config, fields))) {
      await recordRejected(base, 'PayFast did not confirm this notification.');
      return ok();
    }
    const outcome = OUTCOMES[data.payment_status ?? ''];
    if (!outcome) {
      await recordRejected(base, `Unknown payment status ${data.payment_status}.`);
      return ok();
    }
    const amount = data.amount_gross ? Math.round(Number(data.amount_gross) * 100) : null;
    const result = await applyPaymentNotice({
      ...base,
      checkoutId: data.m_payment_id ?? null,
      token: data.token || null,
      outcome,
      amountCents: Number.isFinite(amount) ? amount : null,
    });
    logger.info('PayFast notification.', { outcome, applied: result.applied, problem: result.problem });
  } catch (error) {
    // A failure here is ours, not PayFast's: answering 500 makes PayFast send it again later.
    logger.error('PayFast notification failed.', { error });
    return { statusCode: 500, body: 'Try again' };
  }
  return ok();
};
