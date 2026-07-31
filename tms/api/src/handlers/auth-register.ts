import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { signToken } from '../lib/authtoken';
import { hashPassword } from '../lib/passwords';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { conflict, json, parseBody, route, ApiError } from '../lib/http';

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'Use at least 8 characters.'),
});

const requireLocalDriver = () => {
  if (process.env.AUTH_DRIVER !== 'local' || process.env.NODE_ENV !== 'development') {
    throw new ApiError(404, 'not_found', 'Sign-up is handled by Cognito in this environment.');
  }
};

/** Registration is for tenants: an applicant needs an identity before applying. Landlords are
    provisioned, not self-served, exactly as they would be in the Cognito user pool. */
export const handler = route(async (event) => {
  requireLocalDriver();
  const input = parseBody(event, schema);
  const email = input.email.toLowerCase();

  const existing = await query('select 1 from local_credential where email = $1', [email]);
  if (existing.length > 0) throw conflict('That email already has an account. Sign in instead.');

  const sub = `local-${randomUUID()}`;
  await query(
    `insert into local_credential (sub, email, name, role, password_hash)
     values ($1, $2, $3, 'tenant', $4)`,
    [sub, email, input.name, hashPassword(input.password)],
  );

  const user = { sub, role: 'tenant' as const, name: input.name, email };
  await audit({
    actorSub: sub,
    actorRole: 'tenant',
    action: 'auth.register',
    entity: 'credential',
    entityId: null,
    detail: { email },
  });
  return json(201, { token: signToken(user), user });
});
