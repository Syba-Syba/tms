import { query, withTransaction } from './db';
import { encryptIdNumber } from './idcrypt';
import { audit } from './audit';
import { billableUntil } from './billing';
import { sendTenantInvite } from './tenant-invite';
import { assertUnitRoom } from './subscription';
import { importRowSchema, lastAnniversary, rowProblems, type ImportRow } from '../domain/tenancy-import';
import { billingWindow, describeWindow, rentForWindow } from '../domain/renewal';
import { dateFromIso, sastToday } from '../domain/dates';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

const LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', idNumber: 'ID number',
  startDate: 'Lease start', endDate: 'Lease end', monthlyRentCents: 'Rent', escalationPct: 'Escalation',
  depositHeldCents: 'Deposit', arrearsCents: 'Arrears', arrearsSince: 'Arrears since', property: 'Property',
  unit: 'Unit', bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', currentMonthPaid: 'Paid this month',
};

const issueText = (issue: { path: PropertyKey[]; message: string }) => {
  const label = LABELS[String(issue.path[0] ?? '')];
  return label && !issue.message.startsWith(label) ? `${label}: ${issue.message}` : issue.message;
};

export interface RowResult {
  line: number;
  tenant: string;
  unit: string;
  problems: string[];
  /** Set when the import would add the unit as well. */
  newUnit?: boolean;
}

interface Resolved {
  row: ImportRow;
  unitId: string | null;
  propertyId: string;
  unitLabel: string;
  unitCode: string;
}

const LIVE = `('out_for_signature', 'active', 'scheduled')`;

/** Finds the unit a row names, checking it is this landlord's and free to take a tenancy. */
async function resolveUnit(landlordId: string, row: ImportRow): Promise<{ resolved: Resolved | null; problem: string | null; newUnit: boolean }> {
  if (row.unitId) {
    const [unit] = await query<{ id: string; code: string; property_id: string; name: string; status: string; live: boolean }>(
      `select u.id, u.code, u.property_id, p.name, u.status,
              exists (select 1 from lease l where l.unit_id = u.id and l.status in ${LIVE}) as live
         from unit u join property p on p.id = u.property_id
        where u.id = $1 and p.landlord_id = $2`,
      [row.unitId, landlordId],
    );
    if (!unit) return { resolved: null, problem: 'That unit was not found.', newUnit: false };
    if (unit.live) return { resolved: null, problem: `${unit.name} ${unit.code} already has a lease.`, newUnit: false };
    if (unit.status === 'held') return { resolved: null, problem: `An application is holding ${unit.name} ${unit.code}.`, newUnit: false };
    return { resolved: { row, unitId: unit.id, propertyId: unit.property_id, unitLabel: `${unit.name} ${unit.code}`, unitCode: unit.code }, problem: null, newUnit: false };
  }

  const properties = await query<{ id: string; name: string }>(
    'select id, name from property where landlord_id = $1 and lower(name) = lower($2)',
    [landlordId, row.property],
  );
  if (properties.length === 0) {
    return { resolved: null, problem: `There is no property called "${row.property}". Add it under Properties first.`, newUnit: false };
  }
  if (properties.length > 1) {
    return { resolved: null, problem: `More than one property is called "${row.property}". Rename one first.`, newUnit: false };
  }
  const property = properties[0]!;
  const [unit] = await query<{ id: string; code: string; status: string; live: boolean }>(
    `select u.id, u.code, u.status,
            exists (select 1 from lease l where l.unit_id = u.id and l.status in ${LIVE}) as live
       from unit u where u.property_id = $1 and lower(u.code) = lower($2)`,
    [property.id, row.unit],
  );
  const label = `${property.name} ${unit?.code ?? row.unit}`;
  if (!unit) {
    if (row.bedrooms === undefined || row.bathrooms === undefined) {
      return { resolved: null, problem: `${label} does not exist. Add it, or give its bedrooms and bathrooms to add it here.`, newUnit: false };
    }
    return { resolved: { row, unitId: null, propertyId: property.id, unitLabel: label, unitCode: row.unit! }, problem: null, newUnit: true };
  }
  if (unit.live) return { resolved: null, problem: `${label} already has a lease.`, newUnit: false };
  if (unit.status === 'held') return { resolved: null, problem: `An application is holding ${label}.`, newUnit: false };
  return { resolved: { row, unitId: unit.id, propertyId: property.id, unitLabel: label, unitCode: unit.code }, problem: null, newUnit: false };
}

/** Writes one tenancy: tenant, paperwork, lease, deposit, this month's rent and arrears. */
async function writeTenancy(run: Run, item: Resolved, actorSub: string, today: string): Promise<string> {
  const { row } = item;
  let unitId = item.unitId;
  if (!unitId) {
    const [unit] = await run<{ id: string }>(
      `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [item.propertyId, item.unitCode, row.bedrooms, row.bathrooms, row.monthlyRentCents, row.depositHeldCents],
    );
    unitId = unit!.id;
  }
  const [applicant] = await run<{ id: string }>(
    `insert into applicant (first_name, last_name, id_number_enc, id_number_last4, email, phone, monthly_income_cents)
     values ($1, $2, $3, $4, $5, $6, 0) returning id`,
    [
      row.firstName, row.lastName,
      row.idNumber ? await encryptIdNumber(row.idNumber) : null,
      row.idNumber ? row.idNumber.slice(-4) : null,
      row.email, row.phone,
    ],
  );
  const [application] = await run<{ id: string }>(
    `insert into application (unit_id, applicant_id, status, preferred_move_in, submitted_at, decided_at, decided_by, source)
     values ($1, $2, 'approved', $3, now(), now(), $4, 'import') returning id`,
    [unitId, applicant!.id, row.startDate, actorSub],
  );
  const escalatesFrom = lastAnniversary(row.startDate, today);
  const [lease] = await run<{ id: string; ref: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, escalation_pct,
                        deposit_cents, status, activated_at, source, escalates_from)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now(), 'import', $9)
     returning id, 'LSE-' || lpad(ref_no::text, 5, '0') as ref`,
    [application!.id, unitId, applicant!.id, row.startDate, row.endDate, row.monthlyRentCents, row.escalationPct,
     row.depositHeldCents, escalatesFrom],
  );
  await run(`update unit set status = 'occupied' where id = $1`, [unitId]);
  if (row.depositHeldCents > 0) {
    await run(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
       values ($1, 'received', $2, $3, 'Held before the lease was brought into Threshold')`,
      [lease!.id, row.depositHeldCents, row.startDate],
    );
  }

  // This month's rent, billed the way the monthly run would bill it, so the run finds it
  // already there and does not charge the month again.
  const monthStart = `${today.slice(0, 7)}-01`;
  const window = billingWindow({
    periodStart: dateFromIso(monthStart),
    leaseStart: dateFromIso(row.startDate),
    leaseEnd: billableUntil({ endDate: row.endDate, terminationEffectiveOn: null, renewalStartsOn: null }),
  });
  if (window) {
    const rent = rentForWindow({
      baseRentCents: row.monthlyRentCents,
      escalationPct: row.escalationPct,
      leaseStart: dateFromIso(escalatesFrom),
      window,
    });
    const [invoice] = await run<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, covers_from, covers_to, status)
       values ($1, $2, $2, $3, $4, $5, $6) returning id`,
      [lease!.id, monthStart, rent, window.from, window.to, row.currentMonthPaid ? 'paid' : 'issued'],
    );
    await run(
      `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'rent', $2, $3)`,
      [invoice!.id, `Rent · ${item.unitCode} · ${monthStart.slice(0, 7)}${describeWindow(window)}`, rent],
    );
    if (row.currentMonthPaid) {
      await run(
        `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
         values ($1, $2, $3, 'eft', 'Paid before Threshold', $4, $5)`,
        [lease!.id, invoice!.id, rent, today, actorSub],
      );
    }
  }

  // What was already owed, as one invoice dated when it fell due, so the arrears steps and the
  // age analysis count from the right day.
  if (row.arrearsCents > 0 && row.arrearsSince) {
    const [invoice] = await run<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, $2, $3, $4) returning id`,
      [lease!.id, `${row.arrearsSince.slice(0, 7)}-01`, row.arrearsSince, row.arrearsCents],
    );
    await run(
      `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'other', $2, $3)`,
      [invoice!.id, `Arrears brought forward, owed since ${row.arrearsSince}`, row.arrearsCents],
    );
  }
  return lease!.id;
}

/**
 * Checks every row, then writes all of them or none. A half-imported spreadsheet leaves the
 * landlord working out which tenants made it in, so one problem anywhere stops the lot.
 */
export async function importTenancies(
  landlordId: string,
  inputs: { line: number; input: unknown; problems?: string[] }[],
  options: { actorSub: string; dryRun: boolean; invite: boolean },
) {
  const today = sastToday();
  const results: RowResult[] = [];
  const ready: Resolved[] = [];
  const seenUnits = new Set<string>();

  for (const item of inputs) {
    const problems = [...(item.problems ?? [])];
    const parsed = importRowSchema.safeParse(item.input);
    const raw = (item.input ?? {}) as Record<string, unknown>;
    const tenant = `${String(raw.firstName ?? '')} ${String(raw.lastName ?? '')}`.trim();
    if (!parsed.success) {
      problems.push(...parsed.error.issues.map(issueText));
      results.push({ line: item.line, tenant, unit: `${String(raw.property ?? '')} ${String(raw.unit ?? '')}`.trim(), problems: [...new Set(problems)] });
      continue;
    }
    problems.push(...rowProblems(parsed.data, today));
    const { resolved, problem, newUnit } = await resolveUnit(landlordId, parsed.data);
    if (problem) problems.push(problem);
    const unitLabel = resolved?.unitLabel ?? `${parsed.data.property ?? ''} ${parsed.data.unit ?? ''}`.trim();
    const key = resolved ? (resolved.unitId ?? `${resolved.propertyId}:${resolved.unitCode.toLowerCase()}`) : null;
    if (key && seenUnits.has(key)) problems.push(`${unitLabel} appears twice.`);
    if (key) seenUnits.add(key);
    results.push({ line: item.line, tenant, unit: unitLabel, problems, ...(newUnit ? { newUnit } : {}) });
    if (problems.length === 0 && resolved) ready.push(resolved);
  }

  const failed = results.filter((result) => result.problems.length > 0).length;
  if (failed > 0 || options.dryRun || ready.length === 0) {
    return { results, imported: 0, failed };
  }
  // Units the import adds count against the plan like any other.
  await assertUnitRoom(landlordId, ready.filter((item) => !item.unitId).length);

  const leaseIds = await withTransaction(async (run) => {
    const ids: string[] = [];
    for (const item of ready) {
      const leaseId = await writeTenancy(run, item, options.actorSub, today);
      if (options.invite) await sendTenantInvite(run, { leaseId, invitedBy: options.actorSub });
      ids.push(leaseId);
    }
    return ids;
  });
  for (const leaseId of leaseIds) {
    await audit({
      actorSub: options.actorSub, actorRole: 'landlord', action: 'lease.imported', entity: 'lease',
      entityId: leaseId, detail: { invited: options.invite },
    });
  }
  return { results, imported: leaseIds.length, failed: 0, leaseIds };
}
