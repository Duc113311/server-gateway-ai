import { config } from './config';

interface Bucket {
  /** Timestamps of calls inside the rolling minute. */
  minute: number[];
  /** Calls so far in the current UTC day. */
  day: number;
  /** UTC day the counter belongs to, as `YYYY-MM-DD`. */
  dayKey: string;
}

const buckets = new Map<string, Bucket>();

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface RateVerdict {
  allowed: boolean;
  /** Which limit tripped, for the error body. */
  scope?: 'minute' | 'day';
  /** Seconds until the caller may retry. */
  retryAfter?: number;
}

/**
 * Per-user quota: a rolling one-minute window plus a hard daily cap.
 *
 * Held in memory, so the limits are per instance — run more than one replica
 * and each gets its own allowance. Move this to Firestore or Redis before
 * scaling out.
 */
export function checkRate(uid: string, now = Date.now()): RateVerdict {
  const today = dayKey(now);
  let bucket = buckets.get(uid);

  if (!bucket || bucket.dayKey !== today) {
    bucket = { minute: [], day: 0, dayKey: today };
    buckets.set(uid, bucket);
  }

  const windowStart = now - 60_000;
  bucket.minute = bucket.minute.filter((t) => t > windowStart);

  if (bucket.minute.length >= config.requestsPerMinute) {
    const oldest = bucket.minute[0];
    return {
      allowed: false,
      scope: 'minute',
      retryAfter: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)),
    };
  }

  if (bucket.day >= config.requestsPerDay) {
    const midnight = Date.parse(`${today}T23:59:59.999Z`) + 1;
    return {
      allowed: false,
      scope: 'day',
      retryAfter: Math.max(1, Math.ceil((midnight - now) / 1000)),
    };
  }

  bucket.minute.push(now);
  bucket.day += 1;
  return { allowed: true };
}

/**
 * Drops buckets that have gone quiet, so an instance that has served many
 * one-off users doesn't hold every uid it has ever seen.
 */
export function pruneRateBuckets(now = Date.now()): void {
  const today = dayKey(now);
  for (const [uid, bucket] of buckets) {
    if (bucket.dayKey !== today) buckets.delete(uid);
  }
}
