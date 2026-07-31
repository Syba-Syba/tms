import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { caller, type Caller } from './auth';
import { query } from './db';
import { forbidden, notFound } from './http';

export interface LeaseAccess {
  person: Caller;
  leaseId: string;
  isLandlord: boolean;
  isTenant: boolean;
}

/** Every lease-scoped route funnels through here. Being signed in is not the same as being
    a party to this lease, and the phase 2 to 4 handlers were only checking the former. */
export async function requireLeaseAccess(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  leaseId: string,
): Promise<LeaseAccess> {
  const person = caller(event);
  const [row] = await query<{ tenant_sub: string | null; landlord_sub: string | null }>(
    `select a.cognito_sub as tenant_sub, ll.cognito_sub as landlord_sub
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where l.id = $1`,
    [leaseId],
  );
  if (!row) throw notFound('Lease');

  const isLandlord = person.groups.includes('landlord') && row.landlord_sub === person.sub;
  const isTenant = row.tenant_sub === person.sub;
  if (!isLandlord && !isTenant) throw forbidden('You are not a party to this lease.');
  return { person, leaseId, isLandlord, isTenant };
}

/** Same check, reached through a child record. */
export async function requireLeaseAccessVia(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  sql: string,
  params: unknown[],
  what: string,
): Promise<LeaseAccess> {
  const [row] = await query<{ lease_id: string }>(sql, params);
  if (!row) throw notFound(what);
  return requireLeaseAccess(event, row.lease_id);
}

/** A party may only sign as themselves. Without this, any signed-in user could sign as either side. */
export function assertSigningAs(access: LeaseAccess, party: 'tenant' | 'landlord') {
  if (party === 'tenant' && !access.isTenant) throw forbidden('Only the tenant signs as the tenant.');
  if (party === 'landlord' && !access.isLandlord) {
    throw forbidden('Only the landlord signs as the landlord.');
  }
}
