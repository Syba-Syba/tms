import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION } from '../domain/privacy';
import { TERMS_VERSION } from '../domain/company';
import { slugify } from '../domain/landlord';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/**
 * Many landlords on one installation, each with a team. A landlord signs up, fills in their
 * account, invites an agent, and the agent works the account without ever reaching another
 * landlord's tenants. The seeded landlord (Mokoena Properties) is the neighbour throughout.
 */
type As = { sub: string; groups: string };
const SEEDED: As = { sub: 'sub-landlord', groups: 'landlord' };
const SEEDED_LEASE = '66666666-6666-6666-6666-666666666666';

let call: (method: string, path: string, as: As | null, body?: unknown, ip?: string) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let owner: As;
let agent: As;
let ownerProperty: string;

const inviteToken = async (email: string) => {
  const [row] = await db.query<{ body: string }>(
    `select body from notification where recipient_to = $1 and kind = 'team_invite' order by created_at desc limit 1`,
    [email],
  );
  return row?.body.match(/token=([A-Za-z0-9_-]+)/)?.[1];
};

let address = 0;
const nextIp = () => `10.20.${Math.floor(address / 200)}.${(address++ % 200) + 1}`;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://landlord-accounts-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const { handler } = await import('../api');
  call = async (method, fullPath, as, body, ip) => {
    const [path = fullPath, search] = fullPath.split('?');
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search ?? '')),
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path, sourceIp: ip ?? nextIp(), userAgent: 'test' },
        authorizer: {
          jwt: { claims: { sub: as?.sub ?? 'anonymous', 'cognito:groups': `[${as?.groups ?? 'tenant'}]` } },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('listings links', () => {
  it('turns a business name into a link', () => {
    expect(slugify('Mokoena Properties (Pty) Ltd')).toBe('mokoena-properties-pty-ltd');
    expect(slugify('Ñandú Homes')).toBe('nandu-homes');
    expect(slugify('A')).toBe('landlord-a');
  });
});

describe('landlord sign-up', () => {
  it('opens a landlord account with the person as its owner', async () => {
    const signed = await call('POST', '/auth/register', null, {
      name: 'Sipho Ndlovu', email: 'sipho.ndlovu@example.co.za', password: 'a-long-password',
      consentVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION, landlord: { tradingName: 'Ndlovu Homes', phone: '082 555 1234' },
    });
    expect(signed.status).toBe(201);
    expect(signed.body.user.role).toBe('landlord');
    owner = { sub: signed.body.user.sub, groups: 'landlord' };

    const account = await call('GET', '/landlord', owner);
    expect(account.status).toBe(200);
    expect(account.body).toMatchObject({
      account: { tradingName: 'Ndlovu Homes', slug: 'ndlovu-homes', bank: null },
      me: { role: 'owner' },
      onboarding: { bank: false, property: false, unit: false, done: false },
    });
  });

  it('gives a second business of the same name its own link', async () => {
    const twin = await call('POST', '/auth/register', null, {
      name: 'Other Ndlovu', email: 'other.ndlovu@example.co.za', password: 'a-long-password',
      termsVersion: TERMS_VERSION, landlord: { tradingName: 'Ndlovu Homes', phone: '0825550000' },
    });
    const account = await call('GET', '/landlord', { sub: twin.body.user.sub, groups: 'landlord' });
    expect(account.body.account.slug).toBe('ndlovu-homes-2');
  });

  it('needs a phone number for the business', async () => {
    const missing = await call('POST', '/auth/register', null, {
      name: 'No Phone', email: 'nophone@example.co.za', password: 'a-long-password',
      termsVersion: TERMS_VERSION, landlord: { tradingName: 'Phoneless' },
    });
    expect(missing.status).toBe(400);
  });

  it('starts with an empty portfolio, not the seeded landlord\'s', async () => {
    const properties = await call('GET', '/properties', owner);
    expect(properties.body.items).toEqual([]);
    const leases = await call('GET', '/leases', owner);
    expect(leases.body.items).toEqual([]);
    expect((await call('GET', `/leases/${SEEDED_LEASE}`, owner)).status).toBe(403);
  });

  it('takes bank details as a set, from the owner, and logs the change', async () => {
    const half = await call('PUT', '/landlord', owner, { bank: { name: 'Capitec', holder: 'S Ndlovu' } });
    expect(half.status).toBe(400);
    const badBranch = await call('PUT', '/landlord', owner, {
      bank: { name: 'Capitec', holder: 'S Ndlovu', accountNumber: '1234567890', branchCode: '47' },
    });
    expect(badBranch.status).toBe(400);
    const saved = await call('PUT', '/landlord', owner, {
      bank: { name: 'Capitec', holder: 'S Ndlovu', accountNumber: '1234567890', branchCode: '470010' },
    });
    expect(saved.status).toBe(200);
    const taken = await call('PUT', '/landlord', owner, { slug: 'mokoena-properties' });
    expect(taken.status).toBe(409);

    const log = await call('GET', '/audit?entity=landlord', owner);
    expect(log.body.items.map((item: any) => item.action)).toContain('landlord.bank_changed');
  });

  it('ticks off the checklist as the portfolio fills', async () => {
    const property = await call('POST', '/properties', owner, {
      name: 'Ndlovu Court', addressLine1: '4 Long Street', suburb: 'Soweto', city: 'Johannesburg',
      province: 'Gauteng', postalCode: '1804',
    });
    expect(property.status).toBe(201);
    ownerProperty = property.body.id;
    await call('POST', `/properties/${ownerProperty}/units`, owner, {
      code: 'N1', bedrooms: 2, bathrooms: 1, monthlyRentCents: 650000, depositCents: 650000,
    });
    const account = await call('GET', '/landlord', owner);
    expect(account.body.onboarding).toMatchObject({ bank: true, property: true, unit: true, done: true });
  });

  it('lists each landlord\'s vacant units under their own link only', async () => {
    const mine = await call('GET', '/units/available?landlord=ndlovu-homes', { sub: 'sub-browser', groups: 'tenant' });
    expect(mine.body.landlord).toEqual({ name: 'Ndlovu Homes' });
    expect(mine.body.items.map((unit: any) => unit.label)).toEqual(['Ndlovu Court N1']);
    const bare = await call('GET', '/units/available', { sub: 'sub-browser', groups: 'tenant' });
    expect(bare.body).toMatchObject({ needsLink: true, items: [] });
    expect((await call('GET', '/units/available?landlord=nobody-here', { sub: 'sub-browser', groups: 'tenant' })).status).toBe(404);
  });
});

describe('agents', () => {
  it('only the owner invites, and not an email that already has an account', async () => {
    expect((await call('POST', '/landlord/invites', SEEDED, { name: 'Xolani', email: 'x@example.co.za' })).status).toBe(201);
    const tenantEmail = await call('POST', '/landlord/invites', owner, { name: 'Naledi', email: 'naledi@example.co.za' });
    expect(tenantEmail.status).toBe(409);
    expect((await call('POST', '/landlord/invites', { sub: 'sub-tenant', groups: 'tenant' }, { name: 'Yusuf', email: 'y@example.co.za' })).status).toBe(403);
  });

  it('joins through the emailed link, once', async () => {
    const sent = await call('POST', '/landlord/invites', owner, { name: 'Ayanda Khumalo', email: 'ayanda@example.co.za' });
    expect(sent.status).toBe(201);
    const token = await inviteToken('ayanda@example.co.za');
    expect(token).toBeTruthy();
    expect(await db.query('select 1 from landlord_invite where token_hash = $1', [token])).toHaveLength(0);

    const looked = await call('POST', '/invites/lookup', null, { token });
    expect(looked.body).toEqual({ kind: 'agent', name: 'Ayanda Khumalo', email: 'ayanda@example.co.za', landlord: 'Ndlovu Homes', hasAccount: false });

    const joined = await call('POST', '/invites/accept', null, { token, password: 'agent-password', consentVersion: PRIVACY_VERSION });
    expect(joined.status).toBe(201);
    expect(joined.body.user).toMatchObject({ role: 'landlord', email: 'ayanda@example.co.za' });
    agent = { sub: joined.body.user.sub, groups: 'landlord' };
    expect((await call('POST', '/invites/accept', null, { token, password: 'again-password', consentVersion: PRIVACY_VERSION })).status).toBe(404);

    const team = await call('GET', '/landlord/team', owner);
    expect(team.body.members.map((member: any) => [member.name, member.role])).toEqual([
      ['Sipho Ndlovu', 'owner'],
      ['Ayanda Khumalo', 'agent'],
    ]);
  });

  it('works the owner\'s portfolio and nobody else\'s', async () => {
    const account = await call('GET', '/landlord', agent);
    expect(account.body.me.role).toBe('agent');
    const properties = await call('GET', '/properties', agent);
    expect(properties.body.items.map((item: any) => item.id)).toEqual([ownerProperty]);
    const unit = await call('POST', `/properties/${ownerProperty}/units`, agent, {
      code: 'N2', bedrooms: 1, bathrooms: 1, monthlyRentCents: 500000, depositCents: 500000,
    });
    expect(unit.status).toBe(201);
    expect((await call('GET', `/leases/${SEEDED_LEASE}`, agent)).status).toBe(403);
    expect((await call('GET', `/leases/${SEEDED_LEASE}/statement`, agent)).status).toBe(403);
    const seededProperties = await call('GET', '/properties', SEEDED);
    expect(seededProperties.body.items.map((item: any) => item.id)).not.toContain(ownerProperty);
  });

  it('cannot change the account, the team, or delete property', async () => {
    expect((await call('PUT', '/landlord', agent, { tradingName: 'Ayanda Rentals' })).status).toBe(403);
    expect((await call('POST', '/landlord/invites', agent, { name: 'Zola', email: 'z@example.co.za' })).status).toBe(403);
    expect((await call('POST', `/landlord/members/${owner.sub}/remove`, agent)).status).toBe(403);
    expect((await call('DELETE', `/properties/${ownerProperty}`, agent)).status).toBe(404);
  });

  it('shows the agent by name in the activity log', async () => {
    const log = await call('GET', '/audit?entity=unit', owner);
    const created = log.body.items.find((item: any) => item.action === 'unit.created' && item.actor.name !== 'You');
    expect(created.actor.name).toBe('Ayanda Khumalo');
  });

  it('loses access the moment the owner removes them', async () => {
    expect((await call('POST', `/landlord/members/${owner.sub}/remove`, owner)).status).toBe(409);
    expect((await call('POST', `/landlord/members/${agent.sub}/remove`, owner)).status).toBe(200);
    expect((await call('GET', '/properties', agent)).status).toBe(403);
    const login = await call('POST', '/auth/login', null, { email: 'ayanda@example.co.za', password: 'agent-password' });
    expect(login.status).toBe(403);
  });

  it('can be uninvited before they join', async () => {
    const sent = await call('POST', '/landlord/invites', owner, { name: 'Thabo', email: 'thabo@example.co.za' });
    const token = await inviteToken('thabo@example.co.za');
    expect((await call('POST', `/landlord/invites/${sent.body.id}/revoke`, owner)).status).toBe(200);
    expect((await call('POST', '/invites/lookup', null, { token })).status).toBe(404);
  });
});

describe('paying the right landlord', () => {
  it('puts the landlord\'s bank account on the tenant\'s statement', async () => {
    const statement = await call('GET', `/leases/${SEEDED_LEASE}/statement`, { sub: 'sub-tenant', groups: 'tenant' });
    expect(statement.body.bank).toEqual({
      name: 'FNB', holder: 'Mokoena Properties', accountNumber: '62812345678', branchCode: '250655',
    });
  });
});
