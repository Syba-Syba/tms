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
  private recordsSinceSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Keys kept at most; past it the oldest go first. */
    private readonly maxKeys = 100_000,
  ) {}

  private recent(rawKey: string): number[] {
    const key = limiterKey(rawKey);
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

  record(rawKey: string): void {
    const key = limiterKey(rawKey);
    const kept = this.recent(key);
    // Re-inserted, so the Map's order stays oldest-touched first for the eviction below.
    this.attempts.delete(key);
    this.attempts.set(key, [...kept, this.now()]);
    // A key only shrinks when it is looked up again, so one used once (a random email in a
    // password-spraying run) stayed for the life of the process. Swept now and then, and capped.
    this.recordsSinceSweep += 1;
    if (this.recordsSinceSweep >= 1000) this.sweep();
    while (this.attempts.size > this.maxKeys) {
      const oldest = this.attempts.keys().next().value as string;
      this.attempts.delete(oldest);
    }
  }

  /** Drops every key whose attempts have all left the window. */
  sweep(): void {
    this.recordsSinceSweep = 0;
    const cutoff = this.now() - this.windowMs;
    for (const [key, times] of this.attempts) {
      if ((times[times.length - 1] ?? 0) <= cutoff) this.attempts.delete(key);
    }
  }

  /** Keys currently held, for tests. */
  get size(): number {
    return this.attempts.size;
  }

  /** Seconds until the oldest counted attempt leaves the window. */
  retryAfterSeconds(key: string): number {
    const oldest = this.recent(key)[0];
    if (oldest === undefined) return 0;
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  /** Attempts the key may still make inside the window. */
  remaining(key: string): number {
    return Math.max(0, this.limit - this.recent(key).length);
  }

  clear(key: string): void {
    this.attempts.delete(limiterKey(key));
  }
}

/**
 * An IPv6 address counts by its /64: one connection usually holds the whole /64 and can move
 * through it at will, so the full address was never limited. An IPv4 address written in IPv6
 * form (::ffff:1.2.3.4) counts as the IPv4 address. Any other key (an email, a sub) is as given.
 */
export function limiterKey(key: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(key);
  if (mapped) return mapped[1]!;
  if (!/^[0-9a-f:]+$/i.test(key) || !key.includes('::') && key.split(':').length !== 8) return key;
  const [head = '', tail] = key.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  if (tail === undefined && left.length !== 8) return key;
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => group.length > 4)) return key;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
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

/**
 * PayFast notices that fail the signature (or are too big to be one) kept on file per address
 * per hour. Anyone can post them; past this they are logged and not stored.
 */
export const unsignedNoticesByAddress = new AttemptLimiter(20, HOUR);

/**
 * Tenancy imports per landlord account per hour, previews included. Each call parses up to
 * 2 MB of spreadsheet and looks up every unit, so a loop of them is real load on the database.
 */
export const importsByLandlord = new AttemptLimiter(30, HOUR);

/**
 * Invitation emails sent by imports per landlord account per day. Enough to bring a 500-unit
 * portfolio across in one go, while keeping an account from using imports as a mailer.
 */
export const importInvitesByLandlord = new AttemptLimiter(500, DAY);

/**
 * Tickets per account. Each one queues an urgent email to the landlord, and the outbox is one
 * queue for the whole platform, so a loop of tickets delayed every other landlord's notices.
 * Generous for a household reporting what broke; nothing for a script.
 */
export const ticketsByAccountHourly = new AttemptLimiter(10, HOUR);
export const ticketsByAccountDaily = new AttemptLimiter(30, DAY);
