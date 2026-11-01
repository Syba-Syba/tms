import { tooManyRequests } from './http';

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

/**
 * Reset requests send email, so they are capped per address and per account. The account cap
 * is silent (the caller always gets the same answer) so it cannot be used to learn which
 * emails exist, and it stops anyone flooding a tenant's inbox.
 */
export const resetRequestsByAddress = new AttemptLimiter(10, 60 * MINUTE);
export const resetRequestsByAccount = new AttemptLimiter(3, 60 * MINUTE);

/**
 * Wrong two-step codes inside the app (changing the bank account, turning two-step off). Sign-in
 * has its own limits; without these, a stolen session could guess six digits until one landed.
 */
export const secondStepsByAccount = new AttemptLimiter(5, 15 * MINUTE);

/** Guesses at a reset token. 256 bits cannot be guessed, but each attempt still costs scrypt. */
export const resetConfirmsByAddress = new AttemptLimiter(20, 15 * MINUTE);

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Applications per connection per day. Each one holds a vacant unit, so a loop of free tenant
 * accounts from one machine could otherwise empty a landlord's listings in minutes.
 */
export const applicationsByAddress = new AttemptLimiter(10, DAY);

/**
 * Invitation emails (team invites and tenant re-invites) per landlord account, by the hour and
 * by the day. Each one is an email from our domain to any address the landlord types, carrying
 * the trading name they chose, so without a cap the app is a free mailer.
 */
export const invitesByLandlordHourly = new AttemptLimiter(10, HOUR);
export const invitesByLandlordDaily = new AttemptLimiter(30, DAY);

/** Invitation emails to one recipient per day, whoever sends them, so nobody's inbox is flooded. */
export const invitesByRecipient = new AttemptLimiter(3, DAY);

/**
 * Upload links per account per hour, across documents, ticket and inspection photos and payment
 * slips. Each link lets the holder write up to 15 MB; the per-record pending caps stop piling up
 * on one record and this stops spreading the same across many.
 */
export const uploadLinksByAccount = new AttemptLimiter(120, HOUR);

/** Refuses an upload link once the account has had its hourly share. Record after issuing one. */
export function requireUploadLinkAllowance(sub: string) {
  if (!uploadLinksByAccount.allows(sub)) {
    throw tooManyRequests('Too many uploads started in the last hour. Finish the ones in progress, or try again later.');
  }
}
