import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { forbidden } from './http';

export interface Caller {
  sub: string;
  email: string;
  groups: string[];
}

export function caller(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller {
  const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
  // API Gateway flattens the array claim to "[landlord tenant]", brackets included.
  const raw = claims['cognito:groups'];
  const groups = (Array.isArray(raw) ? raw : String(raw ?? '').replace(/^\[|\]$/g, '').split(/[\s,]+/))
    .map((group) => String(group).trim())
    .filter(Boolean);
  return { sub: String(claims.sub ?? ''), email: String(claims.email ?? ''), groups };
}

export function requireLandlord(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller {
  const person = caller(event);
  if (!person.groups.includes('landlord')) throw forbidden('Landlord access only.');
  return person;
}
