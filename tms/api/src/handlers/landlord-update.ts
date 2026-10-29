import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { ApiError, conflict, json, parseBody, route } from '../lib/http';
import { notify } from '../lib/notify';
import { requireSecondStep, twoStepEnabled } from '../lib/two-step';
import { updateAccountSchema } from '../domain/landlord';

/**
 * The owner edits the business details. The bank account prints on every invoice, so only the
 * owner changes it, and changing one already on file needs a current two-step code: a stolen
 * password alone must not be enough to redirect the rent. Every change is in the activity log
 * with the old and new last four digits, the owner is emailed, and every tenant is told.
 */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  const input = parseBody(event, updateAccountSchema);
  const code = (JSON.parse(event.body ?? '{}') as { code?: unknown }).code;

  const [before] = await query<{ bank_name: string | null; bank_account_number: string | null; bank_branch_code: string | null }>(
    'select bank_name, bank_account_number, bank_branch_code from landlord where id = $1',
    [landlordId],
  );
  const bankChanges =
    input.bank !== undefined &&
    (input.bank.accountNumber !== before?.bank_account_number || input.bank.branchCode !== before?.bank_branch_code);
  const replacing = bankChanges && Boolean(before?.bank_account_number);

  // Under Cognito there is no local credential: its own MFA guards the sign-in instead.
  if (replacing && process.env.AUTH_DRIVER === 'local') {
    if (!(await twoStepEnabled(person.sub))) {
      throw new ApiError(403, 'two_step_required', 'Turn on two-step sign-in under Settings, You, before changing the bank account.');
    }
    await requireSecondStep(person.sub, code);
  }

  const sets: string[] = [];
  const values: unknown[] = [landlordId];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (input.tradingName !== undefined) set('trading_name', input.tradingName);
  if (input.email !== undefined) set('email', input.email.toLowerCase());
  if (input.phone !== undefined) set('phone', input.phone);
  if (input.registrationNo !== undefined) set('registration_no', input.registrationNo || null);
  if (input.vatNo !== undefined) set('vat_no', input.vatNo || null);
  if (input.slug !== undefined) set('slug', input.slug);
  if (input.bank) {
    set('bank_name', input.bank.name);
    set('bank_account_holder', input.bank.holder);
    set('bank_account_number', input.bank.accountNumber);
    set('bank_branch_code', input.bank.branchCode);
  }

  if (input.slug !== undefined) {
    const [taken] = await query<{ id: string }>('select id from landlord where slug = $1 and id <> $2', [input.slug, landlordId]);
    if (taken) throw conflict('Another landlord already uses that link. Try a different one.');
  }

  await withTransaction(async (run) => {
    await run(`update landlord set ${sets.join(', ')} where id = $1`, values);
    if (!replacing || !input.bank) return;
    const bank = input.bank;
    const last4 = bank.accountNumber.slice(-4);
    const [account] = await run<{ trading_name: string; email: string; phone: string; owner_email: string | null }>(
      `select l.trading_name, l.email, l.phone,
              (select c.email from local_credential c where c.sub = $2) as owner_email
         from landlord l where l.id = $1`,
      [landlordId, person.sub],
    );
    // The owner hears about it at both addresses: if this was not them, the business email may
    // be in the wrong hands too.
    const alert = {
      subject: 'The bank account for rent was changed',
      body:
        `The account tenants pay rent into was changed to ${bank.name}, account ending ${last4}` +
        `${before?.bank_account_number ? `, from the account ending ${before.bank_account_number.slice(-4)}` : ''}.\n\n` +
        `Every tenant has been told. If you did not make this change, sign in, change your password and put the ` +
        `right account back now, then phone your tenants before they pay.`,
    };
    for (const to of new Set([account!.email, account!.owner_email].filter((value): value is string => Boolean(value)))) {
      await run(
        `insert into notification (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
         values ($1, $2, 'email', 'account', 'bank_changed_alert', true, $3, $4)`,
        [person.sub, to, alert.subject, alert.body],
      );
    }
    const tenants = await run<{ lease_id: string; sub: string; email: string; phone: string; unit: string; ref: string }>(
      `select l.id as lease_id, coalesce(a.cognito_sub, 'applicant:' || a.id) as sub, a.email, a.phone,
              p.name || ' ' || u.code as unit, 'LSE-' || lpad(l.ref_no::text, 5, '0') as ref
         from lease l
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property p on p.id = u.property_id
        where p.landlord_id = $1 and l.status in ('active', 'scheduled') and a.erased_at is null`,
      [landlordId],
    );
    for (const tenant of tenants) {
      await notify(
        {
          leaseId: tenant.lease_id,
          to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
          kind: 'landlord_bank_changed',
          dedupeKey: `bank_changed:${tenant.lease_id}:${bank.accountNumber}:${bank.branchCode}`,
          data: {
            landlord: account!.trading_name, unit: tenant.unit, bank: bank.name, last4, reference: tenant.ref,
            phone: account!.phone,
          },
        },
        run,
      );
    }
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: bankChanges ? 'landlord.bank_changed' : 'landlord.updated',
    entity: 'landlord',
    entityId: landlordId,
    detail: {
      fields: Object.keys(input),
      ...(bankChanges
        ? { from: before?.bank_account_number?.slice(-4) ?? null, to: input.bank!.accountNumber.slice(-4) }
        : {}),
    },
  });
  return json(200, { ok: true });
});
