/**
 * Counts attempts per key inside a sliding window and refuses once the limit is reached.
 *
 * Sign-in had no limit at all, so anything that could reach the port could try passwords as
 * fast as scrypt allowed. In self-hosted mode there is one process, so memory is the right
 * place for this. In Lambda each warm container keeps its own count, which is weaker but
 * still caps a single container; Cognito brings its own lockout there anyway.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.attempts.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length > 0) this.attempts.set(key, kept);
    else this.attempts.delete(key);
    return kept;
  }

  /** True while the key still has attempts left. */
  allows(key: string): boolean {
    return this.recent(key).length < this.limit;
  }

  record(key: string): void {
    this.attempts.set(key, [...this.recent(key), this.now()]);
  }

  /** Seconds until the oldest counted attempt leaves the window. */
  retryAfterSeconds(key: string): number {
    const oldest = this.recent(key)[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

const MINUTE = 60_000;

/**
 * Failed sign-ins per account: ten in fifteen minutes is generous for someone who mistyped and
 * nothing for someone guessing. Per address as well, so one machine cannot walk the list of
 * accounts ten guesses at a time.
 */
export const failedLoginsByAccount = new AttemptLimiter(10, 15 * MINUTE);
export const failedLoginsByAddress = new AttemptLimiter(30, 15 * MINUTE);

/** Sign-ups per address. Each one writes a row and runs scrypt. */
export const registrationsByAddress = new AttemptLimiter(10, 60 * MINUTE);

/** Password changes per account, which also run scrypt twice. */
export const passwordChangesByAccount = new AttemptLimiter(10, 15 * MINUTE);
