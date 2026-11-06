import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION, erasureBlock, retainedUntil } from '../domain/privacy';
import { grantStatements } from '../../scripts/db-grants.mjs';

/** The fourth audit: holdover leases and retention, erasure reaching another landlord's
    messages, decision inputs overwritten, Cognito sign-ins left behind, and the app role
    that could not run a landlord's erasure on self-hosted Postgres. */

const cognito = vi.hoisted(() => ({
  deleted: [] as Array<{ UserPoolId: string; Username: string }>,
  beforeSend: null as null | (() => Promise<void>),
}));
vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: class {
    async send(command: { input: { UserPoolId: string; Username: string } }) {
      if (cognito.beforeSend) await cognito.beforeSend();
      cognito.deleted.push(command.input);
      return {};
    }
  },
  AdminDeleteUserCommand: class {
    constructor(public input: unknown) {}
  },
}));

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const SEED_LANDLORD = '11111111-1111-1111-1111-111111111111';
const UNIT_B1 = '33333333-3333-3333-3333-333333333335';

let call: (method: string, path: string, as: As | null, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let privacy: typeof import('../lib/privacy');
let otherLandlord: string;
let otherProperty: string;
let seedProperty: string;
let unitNo = 0;

const register = async (name: string, email: string) => {
  const made = await call('POST', '/auth/register', null, { name, email, password: 'long-enough-1', consentVersion: PRIVACY_VERSION });
  expect(made.status).toBe(201);
  return { sub: made.body.user.sub as string, groups: 'tenant' };
};
const apply = (as: As, body: Record<string, unknown>) =>
  call('POST', '/applications', as, {
    unitId: UNIT_B1, firstName: 'Naledi', lastName: 'Phiri', idNumber: '9001015009086', phone: '0825551234',
    employmentStatus: 'employed', monthlyIncomeCents: 2000000, occupants: 1, preferredMoveIn: '2099-01-01',
    consentVersion: PRIVACY_VERSION, ...body,
  });
const newUnit = async (propertyId: string) => {
  unitNo += 1;
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 500000, 500000, 'vacant') returning id`,
    [propertyId, `P4-${unitNo}`],
  );
  return unit!.id;
};
const applicantOf = async (applicationId: string) =>
  (await db.query<{ applicant_id: string }>('select applicant_id from application where id = $1', [applicationId]))[0]!.applicant_id;
const lease = async (applicationId: string, unitId: string, status: string, start: string, end: string) => {
  const [row] = await db.query<{ id: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, $3, $4, $5, 500000, 500000, $6) returning id`,
    [applicationId, unitId, await applicantOf(applicationId), start, end, status],
  );
  return row!.id;
};
const decline = (id: string) => call('POST', `/applications/${id}/decision`, LANDLORD, { outcome: 'declined', reason: 'Unit let to someone else.' });

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://privacy-audit-4-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-privacy-audit-4-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  privacy = await import('../lib/privacy');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const [other] = await db.query<{ id: string }>(
    `insert into landlord (trading_name, email, phone, cognito_sub) values ('Other Lets', 'o4@example.co.za', '0820000000', 'sub-landlord-four') returning id`,
  );
  otherLandlord = other!.id;
  const [property] = await db.query<{ id: string }>(
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, 'Other Court', '1 Other Road', 'Melville', 'Johannesburg', 'Gauteng', '2092') returning id`,
    [otherLandlord],
  );
  otherProperty = property!.id;
  seedProperty = (await db.query<{ property_id: string }>('select property_id from unit where id = $1', [UNIT_B1]))[0]!.property_id;

  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? '')),
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path: path.split('?')[0], sourceIp: `10.4.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, userAgent: 'privacy-audit-4' },
        authorizer: { jwt: { claims: { sub: as?.sub ?? 'anonymous', 'cognito:groups': `[${as?.groups ?? 'tenant'}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('21: retention follows the tenancy, not the end date on the lease', () => {
  it('counts five years from when a holdover tenancy really ended', () => {
    const leases = [{ status: 'terminated', endDate: '2021-06-30', terminationEffectiveOn: '2024-03-29' }];
    expect(retainedUntil(leases)).toBe('2029-03-29');
    expect(erasureBlock(leases, '2026-11-05')).toContain('2029-03-29');
  });

  it('still counts from an early termination', () => {
    expect(retainedUntil([{ status: 'terminated', endDate: '2027-01-31', terminationEffectiveOn: '2025-05-31' }])).toBe('2030-05-31');
  });

  it('never lets a sitting tenant be erased, however old the end date', () => {
    for (const status of ['active', 'scheduled', 'out_for_signature']) {
      const block = erasureBlock([{ status, endDate: '2020-02-28', terminationEffectiveOn: null }], '2026-11-05');
      expect(block).toMatch(/still running/);
    }
  });

  it('refuses the landlord erasure of a holdover tenant end to end', async () => {
    const as = await register('Hold Over', 'holdover@example.co.za');
    const made = await apply(as, { email: 'holdover@example.co.za', unitId: await newUnit(seedProperty) });
    expect(made.status).toBe(201);
    await lease(made.body.id, (await db.query<{ unit_id: string }>('select unit_id from application where id = $1', [made.body.id]))[0]!.unit_id, 'active', '2019-03-01', '2020-02-28');
    expect((await call('POST', '/me/erasure-request', as, {})).status).toBe(201);
    const request = (await call('GET', '/privacy-requests', LANDLORD)).body.items.find((i: { email: string }) => i.email === 'holdover@example.co.za');
    expect(request.blockedBecause).toMatch(/still running/);
    expect((await call('POST', `/privacy-requests/${request.id}/decision`, LANDLORD, { decision: 'erase' })).status).toBe(409);
  });
});

describe('22: identity erasure leaves other landlords\' messages to the same address', () => {
  it('keeps another landlord\'s pending notice to an imported tenant with the same email', async () => {
    const as = await register('Naledi Phiri', 'naledi22@example.co.za');
    const made = await apply(as, { email: 'naledi22@example.co.za' });
    await decline(made.body.id);

    // Landlord B imported the same person, on a row of their own with no sign-in.
    const [bRow] = await db.query<{ id: string }>(
      `insert into applicant (first_name, last_name, id_number_enc, id_number_last4, email, phone, monthly_income_cents)
       values ('Naledi', 'Phiri', '\\x01', '9086', 'Naledi22@Example.co.za', '+27825551234', 0) returning id`,
    );
    const unit = await newUnit(otherProperty);
    const [bApp] = await db.query<{ id: string }>(
      `insert into application (unit_id, applicant_id, status, preferred_move_in, source) values ($1, $2, 'approved', '2026-01-01', 'import') returning id`,
      [unit, bRow!.id],
    );
    const bLease = await lease(bApp!.id, unit, 'active', '2026-01-01', '2027-01-01');
    await db.query(
      `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ($1, 'applicant:' || $2, 'Naledi22@Example.co.za', 'email', 'lease', 'notice_served', 'Notice', 'A notice')`,
      [bLease, bRow!.id],
    );
    // And a message that was hers, sent by A to the same address under another name, still goes.
    await db.query(
      `insert into notification (recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ('tenant-invite:x', 'naledi22@example.co.za', 'email', 'lease', 'invite', 'Invite', 'Join')`,
    );

    const erased = await privacy.erasePerson(as.sub, { sub: LANDLORD.sub, role: 'landlord' }, { landlordId: SEED_LANDLORD });
    expect(erased.identityErased).toBe(true);
    const kept = await db.query('select 1 from notification where lease_id = $1', [bLease]);
    expect(kept).toHaveLength(1);
    const gone = await db.query(`select 1 from notification where recipient_sub = 'tenant-invite:x'`);
    expect(gone).toHaveLength(0);
  });
});

describe('23: each application keeps the figures given with it', () => {
  it('shows the first landlord the income given to them, not what was later given to another', async () => {
    const as = await register('Two Landlords', 'two-landlords@example.co.za');
    const toA = await apply(as, { email: 'two-landlords@example.co.za', monthlyIncomeCents: 2000000, unitId: await newUnit(seedProperty) });
    expect(toA.status).toBe(201);
    const toB = await apply(as, { email: 'two-landlords@example.co.za', monthlyIncomeCents: 4500000, unitId: await newUnit(otherProperty) });
    expect(toB.status).toBe(201);
    const listed = (await call('GET', '/applications?status=all', LANDLORD)).body.items.find((i: { id: string }) => i.id === toA.body.id);
    expect(listed.monthlyIncomeCents).toBe(2000000);
  });

  it('drops the income on an application once the landlord erases it', async () => {
    const as = await register('Income Gone', 'income-gone@example.co.za');
    const made = await apply(as, { email: 'income-gone@example.co.za', unitId: await newUnit(seedProperty), monthlyIncomeCents: 3100000 });
    await decline(made.body.id);
    await privacy.erasePerson(as.sub, { sub: LANDLORD.sub, role: 'landlord' }, { landlordId: SEED_LANDLORD });
    const [row] = await db.query<{ monthly_income_cents: string | null; employer: string | null }>(
      'select monthly_income_cents, employer from application where id = $1', [made.body.id],
    );
    expect(row!.monthly_income_cents).toBeNull();
    expect(row!.employer).toBeNull();
  });
});

describe('24: erasure removes a Cognito sign-in too', () => {
  it('deletes the user from the pool once the identity goes', async () => {
    const as = await register('Pool Person', 'pool-person@example.co.za');
    process.env.COGNITO_USER_POOL_ID = 'af-south-1_TEST';
    try {
      expect((await call('POST', '/me/erasure-request', as, {})).status).toBe(200);
    } finally {
      delete process.env.COGNITO_USER_POOL_ID;
    }
    expect(cognito.deleted).toContainEqual({ UserPoolId: 'af-south-1_TEST', Username: as.sub });
  });

  it('calls Cognito only after the erasure is recorded, so a slow call cannot leave it unrecorded', async () => {
    const as = await register('Slow Pool', 'slow-pool@example.co.za');
    let recordedFirst: boolean | null = null;
    cognito.beforeSend = async () => {
      recordedFirst = (await db.query(`select 1 from audit_log where action = 'privacy.erased' and detail->>'personSub' = $1`, [as.sub])).length === 1;
    };
    process.env.COGNITO_USER_POOL_ID = 'af-south-1_TEST';
    try {
      expect((await call('POST', '/me/erasure-request', as, {})).status).toBe(200);
    } finally {
      delete process.env.COGNITO_USER_POOL_ID;
      cognito.beforeSend = null;
    }
    expect(recordedFirst).toBe(true);
  });

  it('keeps the privacy replies of a live Cognito user, who has no local sign-in', async () => {
    const live = 'cognito-live-user';
    await db.query(
      `insert into notification (recipient_sub, recipient_to, channel, category, kind, subject, body, status, created_at)
       values ($1, 'live@example.co.za', 'email', 'account', 'privacy_request', 'Refused', 'Information Regulator', 'sent', now() - interval '40 days')`,
      [live],
    );
    const { handler } = await import('../handlers/privacy-sweep');
    await handler();
    expect(await db.query('select 1 from notification where recipient_sub = $1', [live])).toHaveLength(1);
  });

  it('still removes the last message to someone erased', async () => {
    const as = await register('Last Message', 'last-message@example.co.za');
    expect((await call('POST', '/me/erasure-request', as, {})).status).toBe(200);
    await db.query(
      `insert into notification (recipient_sub, recipient_to, channel, category, kind, subject, body, status, created_at)
       values ($1, 'last-message@example.co.za', 'email', 'account', 'privacy_request', 'Erased', 'Gone', 'sent', now() - interval '40 days')`,
      [as.sub],
    );
    const { handler } = await import('../handlers/privacy-sweep');
    await handler();
    expect(await db.query('select 1 from notification where recipient_sub = $1', [as.sub])).toHaveLength(0);
  });
});

const document = async (applicationId: string, name: string) => {
  await db.query(
    `insert into application_document (application_id, kind, s3_key, content_type, size_bytes) values ($1, 'id_copy', $2, 'application/pdf', 3)`,
    [applicationId, `applications/${applicationId}/id_copy/${name}.pdf`],
  );
};
const documentsOf = async (applicationId: string) =>
  (await db.query('select 1 from application_document where application_id = $1', [applicationId])).length;

describe('25 and 26: the sweep reaches applications with a lease', () => {
  it('removes paperwork of an application whose lease was cancelled', async () => {
    const as = await register('Cancelled Lease', 'cancelled-lease@example.co.za');
    const unit = await newUnit(seedProperty);
    const made = await apply(as, { email: 'cancelled-lease@example.co.za', unitId: unit });
    await lease(made.body.id, unit, 'cancelled', '2025-01-01', '2026-01-01');
    await db.query(`update application set status = 'withdrawn', decided_at = now() - interval '13 months' where id = $1`, [made.body.id]);
    await document(made.body.id, 'cancelled');
    const { handler } = await import('../handlers/privacy-sweep');
    await handler();
    expect(await documentsOf(made.body.id)).toBe(0);
  });

  it('removes paperwork five years after a tenancy ended, and keeps a holdover tenant\'s', async () => {
    const as = await register('Long Gone', 'long-gone@example.co.za');
    const unit = await newUnit(seedProperty);
    const ended = await apply(as, { email: 'long-gone@example.co.za', unitId: unit });
    await db.query(`update application set status = 'approved', decided_at = now() - interval '8 years' where id = $1`, [ended.body.id]);
    await lease(ended.body.id, unit, 'terminated', '2018-01-01', '2019-01-01');
    await document(ended.body.id, 'ended');
    await db.query(
      `insert into credit_check (application_id, bureau, checked_on, outcome, recorded_by) values ($1, 'other', '2018-01-01', 'clear', 'x')`,
      [ended.body.id],
    );

    const as2 = await register('Still Here', 'still-here@example.co.za');
    const unit2 = await newUnit(seedProperty);
    const holding = await apply(as2, { email: 'still-here@example.co.za', unitId: unit2 });
    await db.query(`update application set status = 'approved', decided_at = now() - interval '8 years' where id = $1`, [holding.body.id]);
    await lease(holding.body.id, unit2, 'active', '2018-01-01', '2019-01-01');
    await document(holding.body.id, 'holding');

    const { handler } = await import('../handlers/privacy-sweep');
    await handler();
    expect(await documentsOf(ended.body.id)).toBe(0);
    expect(await db.query('select 1 from credit_check where application_id = $1', [ended.body.id])).toHaveLength(0);
    expect(await documentsOf(holding.body.id)).toBe(1);
  });
});

describe('26: the sweep is not stalled by tenancies still inside their five years', () => {
  it('reaches an expired tenancy behind more than 200 recently ended ones', async () => {
    const recent = await register('Recent Mover', 'recent-mover@example.co.za');
    const recentUnit = await newUnit(seedProperty);
    const template = await apply(recent, { email: 'recent-mover@example.co.za', unitId: recentUnit });
    await db.query(`update application set status = 'approved', updated_at = now() - interval '9 years' where id = $1`, [template.body.id]);
    // 205 copies, each with a lease that ended last year and a document: all still held.
    await db.query(
      `with copies as (
         insert into application (applicant_id, unit_id, status, preferred_move_in, updated_at)
         select applicant_id, unit_id, 'approved', preferred_move_in, now() - interval '9 years' from application, generate_series(1, 205)
          where id = $1
         returning id, applicant_id, unit_id),
       leases as (
         insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, deposit_cents, status)
         select id, unit_id, applicant_id, '2024-01-01', '2025-01-01', 500000, 500000, 'terminated' from copies returning application_id)
       insert into application_document (application_id, kind, s3_key, content_type, size_bytes)
       select application_id, 'id_copy', 'applications/' || application_id || '/id_copy/r.pdf', 'application/pdf', 3 from leases`,
      [template.body.id],
    );

    const old = await register('Old Tenant', 'old-tenant@example.co.za');
    const oldUnit = await newUnit(seedProperty);
    const gone = await apply(old, { email: 'old-tenant@example.co.za', unitId: oldUnit });
    await db.query(`update application set status = 'approved' where id = $1`, [gone.body.id]);
    await lease(gone.body.id, oldUnit, 'terminated', '2017-01-01', '2018-01-01');
    await document(gone.body.id, 'old');

    const { handler, tenancyCandidates } = await import('../handlers/privacy-sweep');
    // Whatever order the database returns rows in, none still inside its period takes a place.
    const recentApplicant = await applicantOf(template.body.id);
    const candidates = await tenancyCandidates();
    expect(candidates.filter((c) => c.applicant_id === recentApplicant)).toHaveLength(0);
    expect(candidates.map((c) => c.id)).toContain(gone.body.id);
    await handler();
    expect(await documentsOf(gone.body.id)).toBe(0);
    const [held] = await db.query<{ n: number }>(
      `select count(*)::int as n from application_document d join application a on a.id = d.application_id
        where a.applicant_id = $1`,
      [recentApplicant],
    );
    expect(held!.n).toBe(205);
  });
});

/** A tenant on one of the seed landlord's units, with a lease, ready for a landlord erasure. */
const tenantWithLease = async (name: string, email: string) => {
  const as = await register(name, email);
  const unit = await newUnit(seedProperty);
  const made = await apply(as, { email, unitId: unit });
  expect(made.status).toBe(201);
  await db.query(`update application set status = 'approved' where id = $1`, [made.body.id]);
  const leaseId = await lease(made.body.id, unit, 'terminated', '2015-01-01', '2016-01-01');
  return { as, applicationId: made.body.id as string, leaseId };
};

describe('27: payment references go from the activity log and messages', () => {
  it('strips the reference the landlord recorded and the one in the proof message', async () => {
    const { as, leaseId } = await tenantWithLease('Naledi Phiri', 'ref27@example.co.za');
    await db.query(
      `insert into payment (lease_id, amount_cents, method, reference, received_on, recorded_by) values ($1, 100, 'eft', 'N PHIRI LSE-00101', '2015-06-01', 'sub-landlord')`,
      [leaseId],
    );
    await db.query(
      `insert into audit_log (actor_sub, actor_role, action, entity, entity_id, detail)
       values ('sub-landlord', 'landlord', 'payment.recorded', 'lease', $1, '{"reference": "N PHIRI LSE-00101", "amountCents": 100}')`,
      [leaseId],
    );
    await db.query(
      `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ($1, 'sub-landlord', 'l@example.co.za', 'email', 'money', 'proof_submitted', 'Proof', 'Paid R1, reference N PHIRI LSE-00101.')`,
      [leaseId],
    );
    await privacy.erasePerson(as.sub, { sub: LANDLORD.sub, role: 'landlord' }, { landlordId: SEED_LANDLORD });
    const [logged] = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where action = 'payment.recorded' and entity_id = $1`, [leaseId],
    );
    expect(logged!.detail).toEqual({ amountCents: 100 });
    const [message] = await db.query<{ body: string }>(`select body from notification where lease_id = $1 and kind = 'proof_submitted'`, [leaseId]);
    expect(message!.body).not.toContain('PHIRI');
  });

  it('removes a short reference only where it stands alone', async () => {
    const { as, leaseId } = await tenantWithLease('Short Ref', 'ref27b@example.co.za');
    await db.query(
      `insert into payment (lease_id, amount_cents, method, reference, received_on, recorded_by) values ($1, 100, 'eft', 'RENT', '2015-06-01', 'sub-landlord')`,
      [leaseId],
    );
    await db.query(
      `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ($1, 'sub-landlord', 'l@example.co.za', 'email', 'money', 'proof_submitted', 'Proof', 'CURRENT balance paid, reference RENT.')`,
      [leaseId],
    );
    await privacy.erasePerson(as.sub, { sub: LANDLORD.sub, role: 'landlord' }, { landlordId: SEED_LANDLORD });
    const [message] = await db.query<{ body: string }>(`select body from notification where lease_id = $1 and kind = 'proof_submitted'`, [leaseId]);
    expect(message!.body).toBe('CURRENT balance paid, reference [reference removed].');
  });
});

describe('28: the note on an erasure request goes with the erasure', () => {
  it('no longer shows the landlord the note once the request is completed', async () => {
    const { as } = await tenantWithLease('Note Writer', 'note28@example.co.za');
    expect((await call('POST', '/me/erasure-request', as, { note: 'I am Note Writer, ID 9001015800087' })).status).toBe(201);
    const pending = (await call('GET', '/privacy-requests', LANDLORD)).body.items.find((i: { email: string }) => i.email === 'note28@example.co.za');
    expect((await call('POST', `/privacy-requests/${pending.id}/decision`, LANDLORD, { decision: 'erase' })).status).toBe(200);
    const done = (await call('GET', '/privacy-requests', LANDLORD)).body.items.find((i: { id: string }) => i.id === pending.id);
    expect(done.note).toBeNull();
    expect(await db.query(`select 1 from privacy_request where person_sub = $1 and note is not null`, [as.sub])).toHaveLength(0);
  });
});

describe('29: the export lists messages sent before they had an account', () => {
  it('includes messages to their stand-in address, their invite and their email on their leases', async () => {
    const { as, leaseId } = await tenantWithLease('Export Person', 'export29@example.co.za');
    const [me] = await db.query<{ id: string }>('select id from applicant where cognito_sub = $1', [as.sub]);
    const message = (sub: string, to: string, subject: string, lease: string | null) =>
      db.query(
        `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
         values ($1, $2, $3, 'email', 'lease', 'x', $4, 'body')`,
        [lease, sub, to, subject],
      );
    await message(`applicant:${me!.id}`, 'export29@example.co.za', 'Before account', leaseId);
    await message('tenant-invite:abc', 'export29@example.co.za', 'Your invite', leaseId);
    await message('applicant:00000000-0000-0000-0000-000000000000', 'Export29@example.co.za', 'Old imported row', leaseId);
    await message('someone-else', 'landlord@example.co.za', 'To the landlord', leaseId);
    const exported = await call('GET', '/me/data-export', as);
    const subjects = exported.body.messagesSentToYou.map((m: { subject: string }) => m.subject);
    expect(subjects).toEqual(expect.arrayContaining(['Before account', 'Your invite', 'Old imported row']));
    expect(subjects).not.toContain('To the landlord');
  });
});

describe('30: a ticket title loses their name and number', () => {
  it('scrubs the title the tenant typed', async () => {
    const { as, leaseId } = await tenantWithLease('Naledi Phiri', 'ticket30@example.co.za');
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'urgent', 'Naledi Phiri - burst geyser, call 082 555 1234 or 0825551234', 'Water everywhere', now(), $2) returning id`,
      [leaseId, as.sub],
    );
    await privacy.erasePerson(as.sub, { sub: LANDLORD.sub, role: 'landlord' }, { landlordId: SEED_LANDLORD });
    const [row] = await db.query<{ title: string }>('select title from ticket where id = $1', [ticket!.id]);
    expect(row!.title).not.toContain('Naledi Phiri');
    expect(row!.title).not.toContain('0825551234');
    expect(row!.title).toContain('burst geyser');
  });
});

describe('65: the app role can run an erasure on self-hosted Postgres', () => {
  it('erases as tms_server, which still cannot rewrite who did what', async () => {
    const { as, leaseId } = await tenantWithLease('Role Person', 'role65@example.co.za');
    await db.query(
      `insert into audit_log (actor_sub, actor_role, action, entity, entity_id, detail) values ($1, 'tenant', 'lease.viewed', 'lease', $2, '{}')`,
      [as.sub, leaseId],
    );
    for (const role of ['tms_server', 'tms_backup']) {
      await db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
    }
    const [{ owner, database }] = (await db.query<{ owner: string; database: string }>(
      'select current_user as owner, current_database() as database',
    )) as [{ owner: string; database: string }];
    // migrate.mjs makes this table; the tests apply migrations without it.
    await db.query('create table if not exists schema_migrations (name text primary key)');
    for (const sql of grantStatements({ server: 'tms_server', backup: 'tms_backup', owner, database })) await db.query(sql);

    await db.query('set role tms_server');
    try {
      const erased = await privacy.erasePerson(as.sub, { sub: LANDLORD.sub, role: 'landlord' }, { landlordId: SEED_LANDLORD });
      expect(erased.identityErased).toBe(true);
      await expect(db.query(`update audit_log set actor_sub = 'someone-else' where entity_id = $1`, [leaseId])).rejects.toThrow();
      await expect(db.query('update audit_log set action = action where entity_id = $1', [leaseId])).rejects.toThrow();
      await expect(db.query('delete from audit_log where entity_id = $1', [leaseId])).rejects.toThrow();
    } finally {
      await db.query('reset role');
    }
    const [row] = await db.query<{ actor_sub: string }>(`select actor_sub from audit_log where action = 'lease.viewed' and entity_id = $1`, [leaseId]);
    expect(row!.actor_sub).toMatch(/^erased:/);
  });
});
