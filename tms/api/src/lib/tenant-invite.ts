import { appUrl, hashResetToken, newResetToken } from './password-reset';
import { INVITE_TTL_DAYS } from '../domain/landlord';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Emails a tenant a link to use the app for their lease. Asking again replaces the earlier link.
 * Tenants already signed in to the app need none, so nothing is sent for them.
 */
export async function sendTenantInvite(run: Run, input: { leaseId: string; invitedBy: string }): Promise<'sent' | 'has_account'> {
  const [row] = await run<{ applicant_id: string; sub: string | null; email: string; first_name: string; landlord: string; unit: string }>(
    `select a.id as applicant_id, a.cognito_sub as sub, a.email, a.first_name, ll.trading_name as landlord,
            p.name || ' ' || u.code as unit
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where l.id = $1`,
    [input.leaseId],
  );
  if (!row) throw new Error(`Lease ${input.leaseId} not found`);
  if (row.sub) return 'has_account';

  const token = newResetToken();
  const link = `${appUrl()}/join?token=${token}`;
  await run(
    'update tenant_invite set revoked_at = now() where lease_id = $1 and accepted_at is null and revoked_at is null',
    [input.leaseId],
  );
  const [invite] = await run<{ id: string }>(
    `insert into tenant_invite (applicant_id, lease_id, email, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id`,
    [row.applicant_id, input.leaseId, row.email, hashResetToken(token), input.invitedBy, INVITE_TTL_DAYS],
  );
  await run(
    `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
     values ($1, $2, $3, 'email', 'account', 'tenant_invite', true, $4, $5)`,
    [
      input.leaseId,
      `tenant-invite:${invite!.id}`,
      row.email,
      `${row.landlord} uses Threshold for ${row.unit}`,
      `Hi ${row.first_name},\n\n${row.landlord} now runs your lease for ${row.unit} on Threshold. In the app you can see ` +
        `your rent and statement, send proof of payment, and report repairs.\n\nOpen this link within ${INVITE_TTL_DAYS} days ` +
        `to choose a password:\n\n${link}\n\nIf you already use Threshold with this email, the link asks for your ` +
        `existing password instead. Nothing about your lease changes either way.`,
    ],
  );
  return 'sent';
}
