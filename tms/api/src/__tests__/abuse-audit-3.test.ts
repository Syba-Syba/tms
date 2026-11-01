import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION } from '../domain/privacy';
import { TERMS_VERSION } from '../domain/company';

const alerts = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock('../lib/alerts', async (original) => ({
  ...(await original<typeof import('../lib/alerts')>()),
  alert: async (key: string) => {
    alerts.keys.push(key);
  },
}));

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const LANDLORD = '11111111-1111-1111-1111-111111111111';
const LEASE = '66666666-6666-6666-6666-666666666666';

type As = { sub: string; groups: string; ip?: string };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://abuse3-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-abuse3-'));
  process.env.KMS_DRIVER = 'local';
  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, path, as, body) => {
    const [rawPath, search = ''] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search)),
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path: rawPath, sourceIp: as.ip ?? `10.93.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

let counter = 0;
const next = () => (counter += 1);

async function newUnit(propertyId = PROPERTY, listed = false): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status, listed)
     values ($1, $2, 1, 1, 700000, 700000, 'vacant', $3) returning id`,
    [propertyId, `AB${next()}`, listed],
  );
  return row!.id;
}

async function newTenant(ip?: string): Promise<As> {
  const n = next();
  const made = await call('POST', '/auth/register', NOBODY, {
    name: `Abuse Person${n}`, email: `abuse3-${n}@example.co.za`, password: 'a-long-password', consentVersion: PRIVACY_VERSION,
  });
  expect(made.status).toBe(201);
  return { sub: made.body.user.sub, groups: 'tenant', ip };
}

async function newLandlord(): Promise<As & { landlordId: string }> {
  const n = next();
  const made = await call('POST', '/auth/register', NOBODY, {
    name: `Owner Person${n}`, email: `abuse3-owner-${n}@example.co.za`, password: 'a-long-password',
    consentVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
    landlord: { tradingName: `Abuse Rentals ${n}`, phone: '082 123 4567' },
  });
  expect(made.status).toBe(201);
  const sub = made.body.user.sub as string;
  const [member] = await db.query<{ landlord_id: string }>('select landlord_id from landlord_member where sub = $1', [sub]);
  return { sub, groups: 'landlord', landlordId: member!.landlord_id };
}

const applyBody = (unitId: string) => ({
  unitId, firstName: 'Abuse', lastName: 'Applicant', idNumber: '9001015009086',
  email: 'abuse@example.co.za', phone: '0825550123', employmentStatus: 'employed',
  monthlyIncomeCents: 4500000, occupants: 1, preferredMoveIn: '2099-01-01', consentVersion: PRIVACY_VERSION,
});

describe('finding 1: applications hold units', () => {
  it('caps the open applications one account can hold at once', async () => {
    const tenant = await newTenant();
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', '/applications', tenant, applyBody(await newUnit()))).status).toBe(201);
    }
    const unit = await newUnit();
    const refused = await call('POST', '/applications', tenant, applyBody(unit));
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/3 applications open/);
    const [row] = await db.query<{ status: string }>('select status from unit where id = $1', [unit]);
    expect(row!.status).toBe('vacant');
  });

  it('caps applications from one connection per day', async () => {
    const ip = '10.94.0.1';
    for (let i = 0; i < 10; i++) {
      const tenant = await newTenant(ip);
      expect((await call('POST', '/applications', tenant, applyBody(await newUnit()))).status).toBe(201);
    }
    const refused = await call('POST', '/applications', await newTenant(ip), applyBody(await newUnit()));
    expect(refused.status).toBe(429);
  });
});

describe('finding 2: invitation emails', () => {
  it('limits team invites per landlord', async () => {
    const owner = await newLandlord();
    for (let i = 0; i < 10; i++) {
      const sent = await call('POST', '/landlord/invites', owner, { name: 'Thabo Agent', email: `team-${next()}@example.co.za` });
      expect(sent.status).toBe(201);
    }
    const refused = await call('POST', '/landlord/invites', owner, { name: 'Thabo Agent', email: `team-${next()}@example.co.za` });
    expect(refused.status).toBe(429);
  });

  it('limits invites to one address, whoever sends them', async () => {
    const email = `victim-${next()}@example.co.za`;
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', '/landlord/invites', await newLandlord(), { name: 'Thabo', email })).status).toBe(201);
    }
    expect((await call('POST', '/landlord/invites', await newLandlord(), { name: 'Thabo', email })).status).toBe(429);
  });

  it('refuses an invite name that is not a name', async () => {
    const owner = await newLandlord();
    for (const name of ['=HYPERLINK("http://evil.example")', 'Click http://evil.example/now', 'x'.repeat(81)]) {
      const refused = await call('POST', '/landlord/invites', owner, { name, email: `named-${next()}@example.co.za` });
      expect(refused.status).toBe(400);
    }
    expect((await call('POST', '/landlord/invites', owner, { name: "Zoë O'Neil-Dlamini Jr.", email: `named-${next()}@example.co.za` })).status).toBe(201);
  });

  it('limits tenant re-invites per tenant address', async () => {
    const owner = await newLandlord();
    const [property] = await db.query<{ id: string }>(
      `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
       values ($1, 'Invite Court', '1 Road', 'Ferndale', 'Randburg', 'Gauteng', '2194') returning id`,
      [owner.landlordId],
    );
    const unit = await newUnit(property!.id);
    const [applicant] = await db.query<{ id: string }>(
      `insert into applicant (first_name, last_name, id_number_enc, id_number_last4, email, phone, employment_status, monthly_income_cents)
       values ('Lerato', 'Imported', '\\x00', '0001', $1, '+27820000000', 'employed', 100) returning id`,
      [`imported-${next()}@example.co.za`],
    );
    const [application] = await db.query<{ id: string }>(
      `insert into application (unit_id, applicant_id, status, preferred_move_in) values ($1, $2, 'approved', '2026-01-01') returning id`,
      [unit, applicant!.id],
    );
    const [lease] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, escalation_pct, deposit_cents, status)
       values ($1, $2, $3, '2026-01-01', '2026-12-31', 700000, 8, 700000, 'active') returning id`,
      [application!.id, unit, applicant!.id],
    );
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', `/leases/${lease!.id}/tenant-invite`, owner)).status).toBe(201);
    }
    expect((await call('POST', `/leases/${lease!.id}/tenant-invite`, owner)).status).toBe(429);
  });
});

describe('finding 3: upload links', () => {
  it('caps pending ticket photo uploads per ticket', async () => {
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'routine', 'Drip', 'Tap drips', now() + interval '7 days', 'sub-tenant') returning id`,
      [LEASE],
    );
    for (let i = 0; i < 20; i++) {
      const link = await call('POST', `/tickets/${ticket!.id}/photos/presign`, TENANT, { phase: 'report', contentType: 'image/jpeg', sizeBytes: 1000 });
      expect(link.status).toBe(201);
    }
    const refused = await call('POST', `/tickets/${ticket!.id}/photos/presign`, TENANT, { phase: 'report', contentType: 'image/jpeg', sizeBytes: 1000 });
    expect(refused.status).toBe(409);
  });

  it('caps pending inspection photo uploads per inspection', async () => {
    const [inspection] = await db.query<{ id: string }>(
      `insert into inspection (lease_id, kind, scheduled_for) values ($1, 'outgoing', current_date) returning id`,
      [LEASE],
    );
    await db.query(
      `insert into inspection_finding (inspection_id, room, item) values ($1, 'Kitchen', 'Sink') on conflict do nothing`,
      [inspection!.id],
    );
    const body = { room: 'Kitchen', item: 'Sink', contentType: 'image/jpeg', sizeBytes: 1000 };
    for (let i = 0; i < 20; i++) {
      expect((await call('POST', `/inspections/${inspection!.id}/photos/presign`, OWNER, body)).status).toBe(201);
    }
    expect((await call('POST', `/inspections/${inspection!.id}/photos/presign`, OWNER, body)).status).toBe(409);
  });

  it('caps unsent payment slips per lease', async () => {
    const body = { target: 'deposit', amountCents: 1000, paidOn: '2026-01-01', contentType: 'application/pdf', sizeBytes: 1000 };
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', `/leases/${LEASE}/payment-proofs`, TENANT, body)).status).toBe(201);
    }
    expect((await call('POST', `/leases/${LEASE}/payment-proofs`, TENANT, body)).status).toBe(409);
  });

  it('records application document links as pending and caps them per application', async () => {
    const tenant = await newTenant();
    const applied = await call('POST', '/applications', tenant, applyBody(await newUnit()));
    const id = applied.body.id as string;
    const body = { kind: 'payslip', contentType: 'application/pdf', sizeBytes: 1000 };
    let key = '';
    for (let i = 0; i < 20; i++) {
      const link = await call('POST', `/applications/${id}/documents/presign`, tenant, body);
      expect(link.status).toBe(201);
      key = link.body.key;
    }
    expect((await call('POST', `/applications/${id}/documents/presign`, tenant, body)).status).toBe(409);
    const [pending] = await db.query<{ n: number }>('select count(*)::int as n from pending_upload where s3_key = $1', [key]);
    expect(pending!.n).toBe(1);
  });

  it('limits upload links per account across records', async () => {
    const tenant = await newTenant();
    const statuses: number[] = [];
    for (let a = 0; a < 7; a++) {
      const applied = await call('POST', '/applications', tenant, applyBody(await newUnit()));
      // Three open applications at most, so withdraw each after use.
      const id = applied.body.id as string;
      for (let i = 0; i < 20; i++) {
        statuses.push((await call('POST', `/applications/${id}/documents/presign`, tenant, { kind: 'other', contentType: 'image/png', sizeBytes: 10 })).status);
      }
      await db.query(`update application set status = 'withdrawn' where id = $1`, [id]);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(120);
    expect(statuses.at(-1)).toBe(429);
  });

  it('sweeps unconfirmed uploads older than an hour, of every kind', async () => {
    const { storage } = await import('../lib/storage');
    const store = storage();
    const bytes = new Uint8Array([1, 2, 3]);
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'other', 'routine', 'Sweep', 'Sweep', now(), 'sub-tenant') returning id`,
      [LEASE],
    );
    const [finding] = await db.query<{ id: string }>(
      `select f.id from inspection_finding f join inspection i on i.id = f.inspection_id where i.lease_id = $1 limit 1`,
      [LEASE],
    );
    const [app] = await db.query<{ id: string }>('select id from application limit 1');
    const old = `now() - interval '2 hours'`;
    const keys = {
      ticketOld: `tickets/${ticket!.id}/report-old.jpg`,
      ticketNew: `tickets/${ticket!.id}/report-new.jpg`,
      ticketDone: `tickets/${ticket!.id}/report-done.kept.jpg`,
      inspectionOld: `inspections/x/old.jpg`,
      proofOld: `payment-proofs/${LEASE}/old.pdf`,
      docOld: `applications/${app!.id}/payslip/00000000-0000-0000-0000-000000000001.pdf`,
      docConfirmed: `applications/${app!.id}/payslip/00000000-0000-0000-0000-000000000002.pdf`,
    };
    for (const key of Object.values(keys)) await store.put(key, bytes, 'application/octet-stream');
    await db.query(
      `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes, uploaded, uploaded_at) values
         ($1, 'report', $2, 'image/jpeg', 3, false, ${old}),
         ($1, 'report', $3, 'image/jpeg', 3, false, now()),
         ($1, 'report', $4, 'image/jpeg', 3, true, ${old})`,
      [ticket!.id, keys.ticketOld, keys.ticketNew, keys.ticketDone],
    );
    await db.query(
      `insert into inspection_photo (finding_id, s3_key, content_type, size_bytes, uploaded, uploaded_at)
       values ($1, $2, 'image/jpeg', 3, false, ${old})`,
      [finding!.id, keys.inspectionOld],
    );
    await db.query(
      `insert into payment_proof (lease_id, target, amount_cents, paid_on, s3_key, content_type, size_bytes, submitted_by, created_at)
       values ($1, 'deposit', 100, '2026-01-01', $2, 'application/pdf', 3, 'sub-tenant', ${old})`,
      [LEASE, keys.proofOld],
    );
    await db.query(
      `insert into pending_upload (s3_key, application_id, created_at) values ($1, $3, ${old}), ($2, $3, ${old})`,
      [keys.docOld, keys.docConfirmed, app!.id],
    );
    await db.query(
      `insert into application_document (application_id, kind, s3_key, content_type, size_bytes) values ($1, 'payslip', $2, 'application/pdf', 3)`,
      [app!.id, keys.docConfirmed],
    );

    const { handler } = await import('../handlers/uploads-sweep');
    await handler();

    const exists = async (key: string) => (await store.sizeOf(key)) !== null;
    expect(await exists(keys.ticketOld)).toBe(false);
    expect(await exists(keys.inspectionOld)).toBe(false);
    expect(await exists(keys.proofOld)).toBe(false);
    expect(await exists(keys.docOld)).toBe(false);
    expect(await exists(keys.ticketNew)).toBe(true);
    expect(await exists(keys.ticketDone)).toBe(true);
    expect(await exists(keys.docConfirmed)).toBe(true);
    const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(sql, params))[0]!.n;
    expect(await count('select count(*)::int as n from ticket_photo where s3_key = $1', [keys.ticketOld])).toBe(0);
    expect(await count('select count(*)::int as n from inspection_photo where s3_key = $1', [keys.inspectionOld])).toBe(0);
    expect(await count('select count(*)::int as n from payment_proof where s3_key = $1', [keys.proofOld])).toBe(0);
    expect(await count('select count(*)::int as n from pending_upload where application_id = $1 and created_at < now() - interval \'1 hour\'', [app!.id])).toBe(0);
    expect(await count('select count(*)::int as n from application_document where s3_key = $1', [keys.docConfirmed])).toBe(1);

    const { JOBS } = await import('../lib/scheduler');
    expect(JOBS.find((job) => job.name === 'uploads-sweep')?.everyMinutes).toBe(60);
  });
});

describe('finding 4: malformed ids and alert keys', () => {
  it('answers a non-uuid path id with 404, not a database error', async () => {
    for (const [method, path] of [
      ['GET', '/leases/not-a-uuid'],
      ['GET', '/tickets/123'],
      ['POST', '/applications/x/withdraw'],
      ['DELETE', `/leases/${LEASE}/charges/nope`],
    ] as const) {
      const answer = await call(method, path, OWNER, {});
      expect(answer.status, `${method} ${path}`).toBe(404);
    }
  });

  it('keeps non-uuid parameters working', async () => {
    const { match } = await import('../router');
    expect(match('POST', '/landlord/members/local-abc/remove')?.params.sub).toBe('local-abc');
  });

  it('keys the failure alert by route template, not by the raw path', async () => {
    const { route } = await import('../lib/http');
    const { match } = await import('../router');
    const failing = route(async () => {
      throw new Error('boom');
    });
    alerts.keys.length = 0;
    for (const id of ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']) {
      const found = match('GET', `/leases/${id}`)!;
      expect(found.route).toBe('GET /leases/{id}');
      await failing({
        rawPath: `/leases/${id}`,
        routeKey: found.route,
        requestContext: { http: { method: 'GET', path: `/leases/${id}` } },
      } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
    }
    expect(alerts.keys).toHaveLength(2);
    expect(new Set(alerts.keys).size).toBe(1);
    expect(alerts.keys[0]).toBe('request:GET /leases/{id}');
  });
});

describe('finding 5: reading application documents is audited', () => {
  it('writes file.viewed for each document link returned', async () => {
    const tenant = await newTenant();
    const applied = await call('POST', '/applications', tenant, applyBody(await newUnit()));
    const id = applied.body.id as string;
    const key = `applications/${id}/id_copy/00000000-0000-0000-0000-00000000000a.pdf`;
    await db.query(
      `insert into application_document (application_id, kind, s3_key, content_type, size_bytes) values ($1, 'id_copy', $2, 'application/pdf', 3)`,
      [id, key],
    );
    const listed = await call('GET', `/applications/${id}/documents`, OWNER);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    const rows = await db.query<{ actor_sub: string; entity: string; detail: { key: string } }>(
      `select actor_sub, entity, detail from audit_log where action = 'file.viewed' and entity_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_sub).toBe('sub-landlord');
    expect(rows[0]!.entity).toBe('application');
    expect(rows[0]!.detail.key).toBe(key);
  });
});

describe('finding 6: public listings page', () => {
  it('hides contact details for a landlord with nothing listed', async () => {
    const owner = await newLandlord();
    const [row] = await db.query<{ slug: string }>('select slug from landlord where id = $1', [owner.landlordId]);
    const page = await call('GET', `/listings?landlord=${row!.slug}`, NOBODY);
    expect(page.status).toBe(200);
    expect(page.body.landlord.email).toBeNull();
    expect(page.body.landlord.phone).toBeNull();
  });

  it('shows contact details once a unit is listed', async () => {
    const [row] = await db.query<{ slug: string }>('select slug from landlord where id = $1', [LANDLORD]);
    await newUnit(PROPERTY, true);
    const page = await call('GET', `/listings?landlord=${row!.slug}`, NOBODY);
    expect(page.body.landlord.email).toBe('owner@example.co.za');
  });
});
