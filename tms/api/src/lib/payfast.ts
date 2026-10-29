import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';

/**
 * PayFast, the South African card and instant-EFT gateway, for the landlord's monthly
 * subscription. Three parts, each as PayFast documents it:
 *
 *  - Checkout: a form the browser posts to PayFast, signed with an MD5 over the fields in a
 *    fixed order plus the account passphrase. subscription_type 1 makes it recurring.
 *  - ITN: PayFast posts the outcome to notify_url. Trusted only when the signature matches,
 *    the sender is PayFast, the amount is what was asked, and PayFast confirms the same data
 *    back to us.
 *  - Subscriptions API: changing the amount when the plan changes, and cancelling.
 */

export interface PayfastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase: string | null;
  sandbox: boolean;
}

export function payfastConfig(): PayfastConfig {
  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
  if (!merchantId || !merchantKey) throw new Error('PAYFAST_MERCHANT_ID and PAYFAST_MERCHANT_KEY must be set for BILLING_DRIVER=payfast.');
  // Without a passphrase the signature is a plain MD5 of public fields: anyone with their own
  // PayFast account could produce a valid-looking notification. It is required.
  const passphrase = process.env.PAYFAST_PASSPHRASE?.trim();
  if (!passphrase) throw new Error('PAYFAST_PASSPHRASE must be set for BILLING_DRIVER=payfast (set the same one in the PayFast dashboard).');
  return {
    merchantId,
    merchantKey,
    passphrase,
    sandbox: process.env.PAYFAST_SANDBOX === 'true',
  };
}

const host = (config: PayfastConfig) => (config.sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za');
export const processUrl = (config: PayfastConfig) => `https://${host(config)}/eng/process`;

/**
 * PayFast signs with PHP's urlencode: spaces as '+', and ! ' ( ) * ~ escaped, which
 * encodeURIComponent leaves alone. A name like O'Brien broke the signature both ways.
 */
const encode = (value: string) =>
  encodeURIComponent(value.trim())
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

/** The signature over fields in the order given, skipping empty ones, with the passphrase last. */
export function signFields(fields: [string, string][], passphrase: string | null): string {
  const pairs = fields.filter(([, value]) => value !== '').map(([key, value]) => `${key}=${encode(value)}`);
  if (passphrase) pairs.push(`passphrase=${encode(passphrase)}`);
  return md5(pairs.join('&'));
}

export interface CheckoutInput {
  checkoutId: string;
  landlordId: string;
  amountCents: number;
  itemName: string;
  firstName: string;
  email: string;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  billingDate: string;
}

const rands = (cents: number) => (cents / 100).toFixed(2);

/** The fields to post to PayFast, in the order its signature needs, signature last. */
export function checkoutFields(config: PayfastConfig, input: CheckoutInput): [string, string][] {
  const fields: [string, string][] = [
    ['merchant_id', config.merchantId],
    ['merchant_key', config.merchantKey],
    ['return_url', input.returnUrl],
    ['cancel_url', input.cancelUrl],
    ['notify_url', input.notifyUrl],
    ['name_first', input.firstName.slice(0, 100)],
    ['email_address', input.email.slice(0, 100)],
    ['m_payment_id', input.checkoutId],
    ['amount', rands(input.amountCents)],
    ['item_name', input.itemName.slice(0, 100)],
    ['custom_str1', input.landlordId],
    ['subscription_type', '1'],
    ['billing_date', input.billingDate],
    ['recurring_amount', rands(input.amountCents)],
    // 3 is monthly; 0 cycles runs until cancelled.
    ['frequency', '3'],
    ['cycles', '0'],
  ];
  return [...fields, ['signature', signFields(fields, config.passphrase)]];
}

/** The ITN body as PayFast sent it, in its order: the signature is over that order. */
export function parseItn(body: string): [string, string][] {
  return body
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      const key = decodeURIComponent(pair.slice(0, at < 0 ? pair.length : at).replace(/\+/g, ' '));
      const value = at < 0 ? '' : decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
      return [key, value] as [string, string];
    });
}

/** The string PayFast signed and expects back for confirmation: every field but the signature. */
export const itnParamString = (fields: [string, string][]) =>
  fields.filter(([key]) => key !== 'signature').map(([key, value]) => `${key}=${encode(value)}`).join('&');

export function itnSignatureValid(fields: [string, string][], passphrase: string | null): boolean {
  const given = fields.find(([key]) => key === 'signature')?.[1];
  if (!given) return false;
  let text = itnParamString(fields);
  if (passphrase) text += `&passphrase=${encode(passphrase)}`;
  return md5(text) === given;
}

const PAYFAST_HOSTS = ['www.payfast.co.za', 'sandbox.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za'];

/** The sender is one of PayFast's own servers, by their published host names. */
export async function fromPayfast(ip: string): Promise<boolean> {
  const addresses = await Promise.all(
    PAYFAST_HOSTS.map((name) => lookup(name, { all: true }).then((found) => found.map((a) => a.address)).catch(() => [] as string[])),
  );
  return addresses.flat().includes(ip.replace(/^::ffff:/, ''));
}

/** PayFast confirms it really sent this data: the last of the four checks. */
export async function confirmedByPayfast(config: PayfastConfig, fields: [string, string][]): Promise<boolean> {
  const response = await fetch(`https://${host(config)}/eng/query/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: itnParamString(fields),
    signal: AbortSignal.timeout(10_000),
  });
  return (await response.text()).trim() === 'VALID';
}

/** Subscriptions API headers and signature: every header and body field, sorted by name. */
export function apiSignature(config: PayfastConfig, timestamp: string, body: Record<string, string>): string {
  const vars: Record<string, string> = {
    'merchant-id': config.merchantId,
    version: 'v1',
    timestamp,
    ...body,
    ...(config.passphrase ? { passphrase: config.passphrase } : {}),
  };
  return md5(
    Object.keys(vars)
      .sort()
      .map((key) => `${key}=${encode(vars[key]!)}`)
      .join('&'),
  );
}

async function subscriptionCall(config: PayfastConfig, method: 'PUT' | 'PATCH', path: string, body: Record<string, string> = {}) {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const response = await fetch(`https://api.payfast.co.za/subscriptions/${path}${config.sandbox ? '?testing=true' : ''}`, {
    method,
    headers: {
      'merchant-id': config.merchantId,
      version: 'v1',
      timestamp,
      signature: apiSignature(config, timestamp, body),
      'content-type': 'application/json',
    },
    body: Object.keys(body).length ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`PayFast ${method} ${path} answered ${response.status}: ${await response.text()}`);
}

export const cancelSubscription = (config: PayfastConfig, token: string) =>
  subscriptionCall(config, 'PUT', `${encodeURIComponent(token)}/cancel`);

/** The amount from the next billing date on, in cents as the API takes it. */
export const updateSubscriptionAmount = (config: PayfastConfig, token: string, amountCents: number) =>
  subscriptionCall(config, 'PATCH', `${encodeURIComponent(token)}/update`, { amount: String(amountCents) });
