import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, parseBody, route } from '../lib/http';
import { CATEGORIES, CHANNELS, isMandatory, preferencesSchema } from '../domain/notification';

export const handler = route(async (event) => {
  const person = caller(event);

  if (event.requestContext.http.method === 'GET') {
    const saved = await query<{ category: string; channel: string; enabled: boolean }>(
      'select category, channel, enabled from notification_preference where person_sub = $1',
      [person.sub],
    );
    const lookup = new Map(saved.map((row) => [`${row.category}:${row.channel}`, row.enabled]));
    return json(200, {
      preferences: CATEGORIES.flatMap((category) =>
        CHANNELS.map((channel) => ({
          category,
          channel,
          enabled: lookup.get(`${category}:${channel}`) ?? true,
          // Statutory deadlines are the reason this feature exists, so they stay on.
          locked: isMandatory(category),
        })),
      ),
    });
  }

  const input = parseBody(event, preferencesSchema);
  for (const preference of input.preferences) {
    if (isMandatory(preference.category)) continue;
    await query(
      `insert into notification_preference (person_sub, category, channel, enabled, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (person_sub, category, channel)
       do update set enabled = excluded.enabled, updated_at = now()`,
      [person.sub, preference.category, preference.channel, preference.enabled],
    );
  }
  return json(200, { saved: input.preferences.filter((p) => !isMandatory(p.category)).length });
});
