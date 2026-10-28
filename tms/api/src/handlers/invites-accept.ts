import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { credentialVersion, signToken } from '../lib/authtoken';
import { withTransaction } from '../lib/db';
import { ApiError, badRequest, conflict, json, notFound, parseBody, route, tooManyRequests } from '../lib/http';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { hashResetToken, requireLocalDriver } from '../lib/password-reset';
import { recordConsent } from '../lib/privacy';
import { failedLoginsByAccount } from '../lib/ratelimit';
import { checkSecondStep, twoStepEnabled } from '../lib/two-step';
import { PRIVACY_VERSION } from '../domain/privacy';

const schema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2).max(120).optional(),
  // At least 8 for a new password; an existing account's password is checked as it is.
  password: z.string().min(1).max(200, 'Use at most 200 characters.'),
  consentVersion: z.string().max(20),
  // For a tenant joining an account that has two-step sign-in on.
  code: z.string().trim().max(12).optional(),
});

const requireNewPassword = (password: string) => {
  if (password.length < 8) throw badRequest('Use at least 8 characters.');
};

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
type User = { sub: string; role: 'landlord' | 'tenant'; name: string; email: string };

/** An agent joins a landlord's team. The email must be new: one sign-in, one landlord. */
async function joinTeam(run: Run, hash: string, input: z.infer<typeof schema>): Promise<{ user: User; passwordHash: string; landlordId: string } | null> {
  const [invite] = await run<{ id: string; landlord_id: string; email: string; name: string; invited_by: string }>(
    `select id, landlord_id, email, name, invited_by from landlord_invite
      where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > now()
      for update`,
    [hash],
  );
  if (!invite) return null;
  const taken = await run('select 1 from local_credential where email = $1', [invite.email]);
  if (taken.length > 0) throw conflict('That email already has an account. Ask the owner to invite another address.');
  requireNewPassword(input.password);
  const sub = `local-${randomUUID()}`;
  const passwordHash = hashPassword(input.password);
  const name = input.name ?? invite.name;
  await run(
    `insert into local_credential (sub, email, name, role, password_hash) values ($1, $2, $3, 'landlord', $4)`,
    [sub, invite.email, name, passwordHash],
  );
  await run(`insert into landlord_member (landlord_id, sub, role, added_by) values ($1, $2, 'agent', $3)`, [
    invite.landlord_id, sub, invite.invited_by,
  ]);
  await run('update landlord_invite set accepted_at = now(), accepted_sub = $2 where id = $1', [invite.id, sub]);
  return { user: { sub, role: 'landlord', name, email: invite.email }, passwordHash, landlordId: invite.landlord_id };
}

/**
 * A tenant whose lease was imported takes it into the app. With no account they choose a
 * password; with one, the password they already have proves the email is theirs, and the lease
 * joins that account. The link alone is not enough to take over an existing account.
 */
async function claimLease(run: Run, hash: string, input: z.infer<typeof schema>): Promise<{ user: User; pv: string; leaseId: string } | null> {
  const [invite] = await run<{ id: string; applicant_id: string; lease_id: string; email: string; name: string }>(
    `select i.id, i.applicant_id, i.lease_id, i.email, a.first_name || ' ' || a.last_name as name
       from tenant_invite i join applicant a on a.id = i.applicant_id
      where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      for update of i`,
    [hash],
  );
  if (!invite) return null;
  const [existing] = await run<{ sub: string; role: string; name: string; password_hash: string; session_epoch: number }>(
    'select sub, role, name, password_hash, session_epoch from local_credential where email = $1',
    [invite.email],
  );

  if (existing) {
    if (!failedLoginsByAccount.allows(invite.email)) throw tooManyRequests('Too many attempts. Try again later.');
    if (!verifyPassword(input.password, existing.password_hash)) {
      failedLoginsByAccount.record(invite.email);
      throw new ApiError(401, 'unauthorised', 'That is not the password for this email. Use the one you sign in with.');
    }
    if (existing.role !== 'tenant') throw conflict('This email signs in to a landlord account. Ask your landlord to use another address.');
    if (await twoStepEnabled(existing.sub, run)) {
      if (!input.code) throw new ApiError(401, 'code_required', 'Enter the code from your authenticator app.');
      if (!(await checkSecondStep(existing.sub, input.code, run))) {
        failedLoginsByAccount.record(invite.email);
        throw new ApiError(401, 'code_wrong', 'That code did not match.');
      }
    }
    const user: User = { sub: existing.sub, role: 'tenant', name: existing.name, email: invite.email };
    // They may have applied somewhere before, which made a tenant record for this sign-in.
    // The lease moves onto it, and the record the landlord typed in goes.
    const [own] = await run<{ id: string }>('select id from applicant where cognito_sub = $1', [existing.sub]);
    if (own) {
      await run('update lease set applicant_id = $1 where applicant_id = $2', [own.id, invite.applicant_id]);
      await run('update application set applicant_id = $1 where applicant_id = $2', [own.id, invite.applicant_id]);
      await run('update tenant_invite set applicant_id = $1 where applicant_id = $2', [own.id, invite.applicant_id]);
      await run('delete from applicant where id = $1', [invite.applicant_id]);
    } else {
      await run('update applicant set cognito_sub = $1 where id = $2', [existing.sub, invite.applicant_id]);
    }
    await run('update tenant_invite set accepted_at = now(), accepted_sub = $2 where id = $1', [invite.id, user.sub]);
    return { user, pv: credentialVersion(existing.password_hash, existing.session_epoch), leaseId: invite.lease_id };
  }

  requireNewPassword(input.password);
  const sub = `local-${randomUUID()}`;
  const passwordHash = hashPassword(input.password);
  const user: User = { sub, role: 'tenant', name: input.name ?? invite.name, email: invite.email };
  await run(
    `insert into local_credential (sub, email, name, role, password_hash) values ($1, $2, $3, 'tenant', $4)`,
    [sub, invite.email, user.name, passwordHash],
  );
  await run('update applicant set cognito_sub = $1 where id = $2', [sub, invite.applicant_id]);
  await run('update tenant_invite set accepted_at = now(), accepted_sub = $2 where id = $1', [invite.id, sub]);
  return { user, pv: credentialVersion(passwordHash), leaseId: invite.lease_id };
}

/** Joins through an emailed link: an agent onto a landlord's team, or a tenant onto their lease. */
export const handler = route(async (event) => {
  requireLocalDriver();
  const input = parseBody(event, schema);
  if (input.consentVersion !== PRIVACY_VERSION) {
    throw badRequest('The privacy notice has changed. Reload the page and read it again.');
  }
  const hash = hashResetToken(input.token);

  const result = await withTransaction(async (run) => {
    const team = await joinTeam(run, hash, input);
    if (team) {
      await recordConsent(run, event, { sub: team.user.sub, kind: 'privacy_notice', version: input.consentVersion });
      return { ...team, pv: credentialVersion(team.passwordHash), kind: 'agent' as const };
    }
    const lease = await claimLease(run, hash, input);
    if (lease) {
      await recordConsent(run, event, { sub: lease.user.sub, kind: 'privacy_notice', version: input.consentVersion });
      return { user: lease.user, pv: lease.pv, kind: 'tenant' as const, leaseId: lease.leaseId };
    }
    throw notFound('Invite');
  });

  await audit(
    result.kind === 'agent'
      ? { actorSub: result.user.sub, actorRole: 'landlord', action: 'landlord.member_joined', entity: 'landlord',
          entityId: result.landlordId, detail: { email: result.user.email } }
      : { actorSub: result.user.sub, actorRole: 'tenant', action: 'lease.tenant_joined', entity: 'lease',
          entityId: result.leaseId, detail: { email: result.user.email } },
  );
  return json(201, { token: signToken({ ...result.user, pv: result.pv }), user: result.user });
});
