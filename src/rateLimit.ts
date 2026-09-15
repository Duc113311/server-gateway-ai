import { config } from './config';

/**
 * Quotas are per feature, not per user: one image can cost what fifty chat
 * turns do, so they cannot share an allowance.
 */
export type Feature = 'chat' | 'image' | 'video' | 'translate';

interface Limits {
  perMinute: number;
  perDay: number;
}

function limitsFor(feature: Feature): Limits {
  switch (feature) {
    case 'image':
      return { perMinute: config.imageRatePerMinute, perDay: config.imageRatePerDay };
    case 'video':
      // A render takes minutes anyway, so one in flight per minute is already
      // more than a user can watch; the daily cap is the real guard.
      return { perMinute: 1, perDay: config.videoRatePerDay };
    case 'translate':
      return {
        perMinute: config.translateRatePerMinute,
        perDay: config.translateRatePerDay,
      };
    default:
      return { perMinute: config.requestsPerMinute, perDay: config.requestsPerDay };
  }
}

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
 * Per-user, per-feature quota: a rolling one-minute window plus a hard daily
 * cap.
 *
 * Held in memory, so the limits are per instance — run more than one replica
 * and each gets its own allowance. Move this to Firestore or Redis before
 * scaling out.
 */
export function checkRate(
  uid: string,
  feature: Feature = 'chat',
  now = Date.now(),
): RateVerdict {
  const limits = limitsFor(feature);
  const today = dayKey(now);
  const key = `${feature}:${uid}`;
  let bucket = buckets.get(key);

  if (!bucket || bucket.dayKey !== today) {
    bucket = { minute: [], day: 0, dayKey: today };
    buckets.set(key, bucket);
  }

  const windowStart = now - 60_000;
  bucket.minute = bucket.minute.filter((t) => t > windowStart);

  if (bucket.minute.length >= limits.perMinute) {
    const oldest = bucket.minute[0];
    return {
      allowed: false,
      scope: 'minute',
      retryAfter: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)),
    };
  }

  if (bucket.day >= limits.perDay) {
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
  for (const [key, bucket] of buckets) {
    if (bucket.dayKey !== today) buckets.delete(key);
  }
}
