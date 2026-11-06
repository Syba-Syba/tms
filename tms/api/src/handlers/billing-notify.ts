import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { applyPaymentNotice, recordRejected, type PaymentNotice } from '../lib/billing-events';
import { billingDriver } from '../lib/billing-driver';
import { logger } from '../lib/logger';
import { confirmedByPayfast, fromPayfast, itnSignatureValid, parseItn, payfastConfig } from '../lib/payfast';
import { unsignedNoticesByAddress } from '../lib/ratelimit';

const ok = (): APIGatewayProxyResultV2 => ({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'OK' });

/** A real ITN has about 30 short fields, well under 4 KB. */
export const MAX_ITN_CHARS = 16 * 1024;
const MAX_ITN_FIELDS = 60;

const clip = (value: string | undefined) => (value === undefined ? null : value.slice(0, 64));
const SUMMARY_FIELDS = ['pf_payment_id', 'm_payment_id', 'merchant_id', 'payment_status'];
const summaryOf = (data: Record<string, string>, ip: string): Record<string, string> => ({
  ...Object.fromEntries(SUMMARY_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]!.slice(0, 64)])),
  source_ip: ip.slice(0, 64),
});

/**
 * Keeps a notice nobody has proved came from PayFast. Past a few per address an hour they are
 * only logged, so a loop of junk posts cannot grow billing_event without end.
 */
async function recordUnsigned(notice: Parameters<typeof recordRejected>[0], problem: string, ip: string) {
  if (!unsignedNoticesByAddress.allows(ip)) {
    logger.warn('PayFast notification refused and not stored.', { ip, problem });
    return;
  }
  unsignedNoticesByAddress.record(ip);
  await recordRejected(notice, problem);
}

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
  const ip = event.requestContext.http?.sourceIp ?? '';
  // Anyone can post here, and a refused notice is kept on file. Until the signature proves
  // PayFast sent it, only a short summary is kept: the whole body let anyone store a megabyte
  // per request.
  const fields = raw.length > MAX_ITN_CHARS ? [] : parseItn(raw);
  const data = Object.fromEntries(fields);
  const summary = { provider: 'payfast', externalId: clip(data.pf_payment_id), payload: summaryOf(data, ip) };
  if (raw.length > MAX_ITN_CHARS || fields.length > MAX_ITN_FIELDS) {
    try {
      await recordUnsigned(summary, `Too large to be a PayFast notification (${raw.length} characters).`, ip);
    } catch (error) {
      logger.error('PayFast notification failed.', { error });
    }
    return ok();
  }
  const base = { provider: 'payfast', externalId: data.pf_payment_id ?? null, payload: data };
  const config = payfastConfig();

  try {
    if (!itnSignatureValid(fields, config.passphrase)) {
      await recordUnsigned(summary, 'Signature does not match.', ip);
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
