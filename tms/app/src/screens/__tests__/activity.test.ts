import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityTime } from '../activity';

describe('activity times (audit 4, item 48)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the API’s Postgres timestamp the way Safari must, as ISO', () => {
    const RealDate = Date;
    // Safari's parser, roughly: only ISO 8601 with a T and a full offset.
    class SafariDate extends RealDate {
      constructor(...args: any[]) {
        if (typeof args[0] === 'string' && !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(args[0])) {
          super(NaN);
        } else {
          super(...(args as []));
        }
      }
    }
    vi.stubGlobal('Date', SafariDate);
    const text = activityTime('2026-10-07 22:33:06.087+00');
    expect(text).not.toMatch(/Invalid/);
    // 22:33 UTC is 00:33 the next day in Johannesburg.
    expect(text).toMatch(/00:33/);
  });
});
