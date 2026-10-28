import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { credentialVersion, signToken } from '../lib/authtoken';
import { hashPassword } from '../lib/passwords';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { recordConsent } from '../lib/privacy';
import { PRIVACY_VERSION } from '../domain/privacy';
import { landlordSignUpSchema } from '../domain/landlord';
import { freeSlug } from '../lib/landlord-account';
import { mode } from '../lib/mode';
import { registrationsByAddress } from '../lib/ratelimit';
import { badRequest, conflict, json, parseBody, route, tooManyRequests, ApiError } from '../lib/http';

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  password: z.string().min(8, 'Use at least 8 characters.').max(200, 'Use at most 200 characters.'),
  // The notice version the person ticked. The app always sends it; without it, the app asks for
  // consent on first sign-in instead, so nobody uses the system without having agreed.
  consentVersion: z.string().max(20).optional(),
  // Present when a landlord signs themselves up: their business, which becomes the account.
  landlord: landlordSignUpSchema.optional(),
});

const requireLocalDriver = () => {
  if (process.env.AUTH_DRIVER !== 'local' || mode() === 'aws') {
    throw new ApiError(404, 'not_found', 'Sign-up is handled by Cognito in this environment.');
  }
};

/** Tenants register to apply for a unit. Landlords register with their business details, which
    open a landlord account with them as its owner. Agents never register here: they join by
    an owner's invitation, so nobody can attach themselves to someone else's account. */
export const handler = route(async (event) => {
  requireLocalDriver();
  const address = event.requestContext.http?.sourceIp ?? 'unknown';
  if (!registrationsByAddress.allows(address)) {
    throw tooManyRequests('Too many accounts created from this connection. Try again later.');
  }
  const input = parseBody(event, schema);
  const email = input.email.toLowerCase();

  if (input.consentVersion !== undefined && input.consentVersion !== PRIVACY_VERSION) {
    throw badRequest('The privacy notice has changed. Reload the page and read it again.');
  }

  const sub = `local-${randomUUID()}`;
  const passwordHash = hashPassword(input.password);
  registrationsByAddress.record(address);
  const role = input.landlord ? ('landlord' as const) : ('tenant' as const);
  const landlordId = await withTransaction(async (run) => {
    const existing = await run('select 1 from local_credential where email = $1', [email]);
    if (existing.length > 0) throw conflict('That email already has an account. Sign in instead.');
    await run(
      `insert into local_credential (sub, email, name, role, password_hash)
       values ($1, $2, $3, $4, $5)`,
      [sub, email, input.name, role, passwordHash],
    );
    let created: string | null = null;
    if (input.landlord) {
      // The trigger on landlord makes this sign-in the account's owner.
      const [account] = await run<{ id: string }>(
        `insert into landlord (trading_name, email, phone, cognito_sub, slug) values ($1, $2, $3, $4, $5) returning id`,
        [input.landlord.tradingName, email, input.landlord.phone, sub, await freeSlug(run, input.landlord.tradingName)],
      );
      created = account!.id;
    }
    if (input.consentVersion) {
      await recordConsent(run, event, { sub, kind: 'privacy_notice', version: input.consentVersion });
    }
    return created;
  });

  const user = { sub, role, name: input.name, email };
  await audit({
    actorSub: sub,
    actorRole: role,
    action: 'auth.register',
    entity: landlordId ? 'landlord' : 'credential',
    entityId: landlordId,
    detail: { email },
  });
  return json(201, { token: signToken({ ...user, pv: credentialVersion(passwordHash) }), user });
});
