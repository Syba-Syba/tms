import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { caller } from './auth';
import { query } from './db';
import { writable } from './subscription';

/**
 * Paths a landlord can still use when the account has lapsed: signing in and out, paying,
 * the account and team settings, their own data, and opening documents (a POST that only reads).
 */
const OPEN = [/^\/auth\//, /^\/billing(\/|$)/, /^\/landlord(\/|$)/, /^\/me\//, /^\/invites\//, /^\/files\/view$/];

/**
 * A lapsed landlord account turns read-only: everything can be seen, nothing changed, until a
 * plan is paid for. Tenants are never stopped, so they can still pay, send slips and report a
 * burst geyser whatever their landlord's subscription is doing.
 */
export async function billingGate(event: APIGatewayProxyEventV2WithJWTAuthorizer, path: string): Promise<APIGatewayProxyResultV2 | null> {
  const method = event.requestContext.http.method;
  if (method === 'GET' || method === 'OPTIONS' || OPEN.some((pattern) => pattern.test(path))) return null;
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
