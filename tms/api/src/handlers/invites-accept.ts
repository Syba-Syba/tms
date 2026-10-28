import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { credentialVersion, signToken } from '../lib/authtoken';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { hashPassword } from '../lib/passwords';
import { hashResetToken, requireLocalDriver } from '../lib/password-reset';
import { recordConsent } from '../lib/privacy';
import { PRIVACY_VERSION } from '../domain/privacy';

const schema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2).max(120).optional(),
  password: z.string().min(8, 'Use at least 8 characters.').max(200, 'Use at most 200 characters.'),
  consentVersion: z.string().max(20),
});

/** The invited person chooses a password and joins as an agent. The link works once. */
export const handler = route(async (event) => {
  requireLocalDriver();
  const input = parseBody(event, schema);
  if (input.consentVersion !== PRIVACY_VERSION) {
    throw badRequest('The privacy notice has changed. Reload the page and read it again.');
  }
  const sub = `local-${randomUUID()}`;
  const passwordHash = hashPassword(input.password);

  const joined = await withTransaction(async (run) => {
    const [invite] = await run<{ id: string; landlord_id: string; email: string; name: string; invited_by: string }>(
      `select id, landlord_id, email, name, invited_by from landlord_invite
        where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > now()
        for update`,
      [hashResetToken(input.token)],
    );
    if (!invite) throw notFound('Invite');
    const taken = await run('select 1 from local_credential where email = $1', [invite.email]);
    if (taken.length > 0) throw conflict('That email already has an account. Ask the owner to invite another address.');
    const name = input.name ?? invite.name;
    await run(
      `insert into local_credential (sub, email, name, role, password_hash) values ($1, $2, $3, 'landlord', $4)`,
      [sub, invite.email, name, passwordHash],
    );
    await run(
      `insert into landlord_member (landlord_id, sub, role, added_by) values ($1, $2, 'agent', $3)`,
      [invite.landlord_id, sub, invite.invited_by],
    );
    await run('update landlord_invite set accepted_at = now(), accepted_sub = $2 where id = $1', [invite.id, sub]);
    await recordConsent(run, event, { sub, kind: 'privacy_notice', version: input.consentVersion });
    return { landlordId: invite.landlord_id, email: invite.email, name };
  });

  await audit({
    actorSub: sub, actorRole: 'landlord', action: 'landlord.member_joined', entity: 'landlord',
    entityId: joined.landlordId, detail: { email: joined.email },
  });
  const user = { sub, role: 'landlord' as const, name: joined.name, email: joined.email };
  return json(201, { token: signToken({ ...user, pv: credentialVersion(passwordHash) }), user });
});
