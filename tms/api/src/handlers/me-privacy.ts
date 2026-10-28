import { z } from 'zod';
import { caller } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { badRequest, json, parseBody, route } from '../lib/http';
import { erasureBlockFor, recordConsent } from '../lib/privacy';
import { PRIVACY_VERSION } from '../domain/privacy';

const schema = z.object({ version: z.string().max(20) });

/**
 * GET: which notice version this person has accepted, and their requests.
 * POST: accept the current notice. The app asks on first use and whenever the version changes.
 */
export const handler = route(async (event) => {
  const person = caller(event);

  if (event.requestContext.http.method === 'POST') {
    const { version } = parseBody(event, schema);
    if (version !== PRIVACY_VERSION) throw badRequest('That is not the current privacy notice. Reload and read it again.');
    await withTransaction((run) => recordConsent(run, event, { sub: person.sub, kind: 'privacy_notice', version }));
    return json(201, { acceptedVersion: version });
  }

  const [latest] = await query<{ version: string; accepted_at: string }>(
    `select version, accepted_at::text from consent
      where person_sub = $1 and kind = 'privacy_notice' order by accepted_at desc limit 1`,
    [person.sub],
  );
  const requests = await query<{ id: string; status: string; created_at: string; response: string | null }>(
    `select id, status, created_at::text, response from privacy_request
      where person_sub = $1 order by created_at desc limit 10`,
    [person.sub],
  );
  return json(200, {
    currentVersion: PRIVACY_VERSION,
    acceptedVersion: latest?.version ?? null,
    acceptedAt: latest?.accepted_at ?? null,
    // Said up front, so nobody asks for erasure without knowing what will happen.
    erasureBlockedBecause: person.groups.includes('landlord') ? null : await erasureBlockFor(person.sub),
    requests: requests.map((row) => ({
      id: row.id, status: row.status, createdAt: row.created_at, response: row.response,
    })),
  });
});
