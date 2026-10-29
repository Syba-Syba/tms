import { z } from 'zod';
import { caller } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { badRequest, json, parseBody, route } from '../lib/http';
import { erasureBlockFor, recordConsent } from '../lib/privacy';
import { PRIVACY_VERSION } from '../domain/privacy';
import { TERMS_VERSION } from '../domain/company';

const schema = z.object({
  version: z.string().max(20),
  // Landlords also accept the terms of service; the privacy notice is the default.
  kind: z.enum(['privacy_notice', 'terms_of_service']).default('privacy_notice'),
});

/**
 * GET: which notice version this person has accepted, and their requests.
 * POST: accept the current notice. The app asks on first use and whenever the version changes.
 */
export const handler = route(async (event) => {
  const person = caller(event);

  if (event.requestContext.http.method === 'POST') {
    const { version, kind } = parseBody(event, schema);
    const current = kind === 'terms_of_service' ? TERMS_VERSION : PRIVACY_VERSION;
    if (version !== current) throw badRequest('That is not the current version. Reload and read it again.');
    await withTransaction((run) => recordConsent(run, event, { sub: person.sub, kind, version }));
    return json(201, { acceptedVersion: version, kind });
  }

  const [latest] = await query<{ version: string; accepted_at: string }>(
    `select version, accepted_at::text from consent
      where person_sub = $1 and kind = 'privacy_notice' order by accepted_at desc limit 1`,
    [person.sub],
  );
  // Landlords and their agents work under the terms of service; tenants do not sign them.
  const [terms] = person.groups.includes('landlord')
    ? await query<{ version: string }>(
        `select version from consent where person_sub = $1 and kind = 'terms_of_service' order by accepted_at desc limit 1`,
        [person.sub],
      )
    : [];
  const requests = await query<{ id: string; status: string; created_at: string; response: string | null; landlord: string | null }>(
    `select r.id, r.status, r.created_at::text, r.response, l.trading_name as landlord
       from privacy_request r left join landlord l on l.id = r.landlord_id
      where r.person_sub = $1 order by r.created_at desc limit 10`,
    [person.sub],
  );
  return json(200, {
    currentVersion: PRIVACY_VERSION,
    acceptedVersion: latest?.version ?? null,
    acceptedAt: latest?.accepted_at ?? null,
    terms: person.groups.includes('landlord') ? { currentVersion: TERMS_VERSION, acceptedVersion: terms?.version ?? null } : null,
    // Said up front, so nobody asks for erasure without knowing what will happen.
    erasureBlockedBecause: person.groups.includes('landlord') ? null : await erasureBlockFor(person.sub),
    requests: requests.map((row) => ({
      id: row.id, status: row.status, createdAt: row.created_at, response: row.response, landlord: row.landlord,
    })),
  });
});
