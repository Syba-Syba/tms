import { describe, expect, it } from 'vitest';
import { AttemptLimiter } from '../lib/ratelimit';

describe('attempt limiter', () => {
  const clock = () => {
    let now = 1_000_000;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };

  it('allows up to the limit and refuses the next', () => {
    const time = clock();
    const limiter = new AttemptLimiter(3, 60_000, time.now);
    for (let i = 0; i < 3; i++) {
      expect(limiter.allows('a')).toBe(true);
      limiter.record('a');
    }
    expect(limiter.allows('a')).toBe(false);
  });

  it('keeps keys apart, so one account locking does not lock another', () => {
    const limiter = new AttemptLimiter(1, 60_000, clock().now);
    limiter.record('a');
    expect(limiter.allows('a')).toBe(false);
    expect(limiter.allows('b')).toBe(true);
  });

  it('lets attempts age out of the window', () => {
    const time = clock();
    const limiter = new AttemptLimiter(2, 60_000, time.now);
    limiter.record('a');
    time.advance(30_000);
    limiter.record('a');
    expect(limiter.allows('a')).toBe(false);
    // The first attempt leaves the window; one slot opens, not two.
    time.advance(30_001);
    expect(limiter.allows('a')).toBe(true);
    limiter.record('a');
    expect(limiter.allows('a')).toBe(false);
  });

  it('says how long until the next attempt is allowed', () => {
    const time = clock();
    const limiter = new AttemptLimiter(1, 60_000, time.now);
    limiter.record('a');
    time.advance(15_000);
    expect(limiter.retryAfterSeconds('a')).toBe(45);
  });

  it('forgets a key once it is cleared, as after a successful sign-in', () => {
    const limiter = new AttemptLimiter(1, 60_000, clock().now);
    limiter.record('a');
    limiter.clear('a');
    expect(limiter.allows('a')).toBe(true);
  });
});
