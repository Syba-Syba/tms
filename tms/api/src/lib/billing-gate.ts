import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { caller } from './auth';
import { query } from './db';
import { writable } from './subscription';

/**
 * Paths a landlord can still use when the account has lapsed: signing in and out, paying,
 * the account and team settings, their own data, and opening documents (a POST that only reads).
 */
const OPEN = [/^\/auth\//, /^\/billing(\/|$)/, /^\/landlord(\/|$)/, /^\/me\//, /^\/invites\//, /^\/files\/view$/];

const ID = '[^/]+';
/**
 * Writes a lapsed landlord can still make because the law sets a deadline on them or they
 * protect the tenant: settling a deposit and the exit inspection and deductions it rests on
 * (Rental Housing Act: 7, 14 or 21 days), answering a POPIA request, deciding a payment slip
 * and recording money paid, and withdrawing or confirming a notice. Refusing these turned an
 * unpaid plan into a missed refund or an ignored erasure request.
 */
const DUTIES: Array<[string, RegExp]> = [
  ['POST', new RegExp(`^/terminations/${ID}/(settle|deductions|withdraw|confirm)$`)],
  ['DELETE', new RegExp(`^/terminations/${ID}/deductions/${ID}$`)],
  ['POST', new RegExp(`^/privacy-requests/${ID}/decision$`)],
  ['POST', new RegExp(`^/payment-proofs/${ID}/decision$`)],
  ['POST', new RegExp(`^/leases/${ID}/(payments|inspections)$`)],
  ['PUT', new RegExp(`^/inspections/${ID}/findings$`)],
  ['POST', new RegExp(`^/inspections/${ID}/(signature|reopen|render|photos/presign)$`)],
];

/** /photos/confirm serves tickets and unit photos too; only an inspection photo is a duty. */
function inspectionPhoto(event: APIGatewayProxyEventV2WithJWTAuthorizer, method: string, path: string) {
  if (method !== 'POST' || path !== '/photos/confirm' || !event.body) return false;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return (JSON.parse(raw) as { scope?: unknown }).scope === 'inspection';
  } catch {
    return false;
  }
}

/**
 * A lapsed landlord account turns read-only: everything can be seen, nothing changed, until a
 * plan is paid for. Tenants are never stopped, so they can still pay, send slips and report a
 * burst geyser whatever their landlord's subscription is doing.
 */
export async function billingGate(event: APIGatewayProxyEventV2WithJWTAuthorizer, path: string): Promise<APIGatewayProxyResultV2 | null> {
  const method = event.requestContext.http.method;
  if (method === 'GET' || method === 'OPTIONS' || OPEN.some((pattern) => pattern.test(path))) return null;
  if (DUTIES.some(([m, pattern]) => m === method && pattern.test(path)) || inspectionPhoto(event, method, path)) return null;
  const person = caller(event);
  if (!person.groups.includes('landlord') || !person.sub) return null;
  const [member] = await query<{ landlord_id: string }>('select landlord_id from landlord_member where sub = $1', [person.sub]);
  if (!member || (await writable(member.landlord_id))) return null;
  return {
    statusCode: 402,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: {
        code: 'subscription_required',
        message: 'Your Threshold plan has lapsed, so nothing can be changed until it is paid. Everything is still here to see.',
      },
    }),
  };
}
