import type { Response } from 'express';
import { log } from '../log';
import { ProviderError } from '../providers';
import { checkRate } from '../rateLimit';
import type { Feature } from '../rateLimit';
import { record } from '../store/requestLog';

/**
 * Applies the per-feature quota and writes the 429 itself.
 *
 * Returns false when the caller is over quota and the response is already
 * finished — the route just returns.
 *
 * A refusal is recorded like any other request. It is one of the most useful
 * rows the dashboard has: it is how an operator sees that a user is hitting
 * the cap, which is otherwise invisible — no provider was called, so nothing
 * else would ever mention it.
 */
export function allow(
  res: Response,
  uid: string,
  feature: Feature,
  prompt?: string,
): boolean {
  const verdict = checkRate(uid, feature);
  if (verdict.allowed) return true;

  log.info(`${feature} uid=${uid} rate limited (${verdict.scope})`);
  record({
    uid,
    feature,
    // No upstream was reached, so naming one would be a lie.
    provider: 'gateway',
    model: '—',
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    status: 'error',
    errorCode: `rate_limited_${verdict.scope}`,
    prompt,
  });

  res
    .status(429)
    .set('retry-after', String(verdict.retryAfter ?? 60))
    .json({
      error: 'rate_limited',
      scope: verdict.scope,
      feature,
      retryAfter: verdict.retryAfter,
    });
  return false;
}

/**
 * Maps an upstream failure onto a status, or rethrows anything that is not one.
 *
 * The upstream's own message can name the model or the key, so it stays in the
 * log and the client only learns whether retrying is worthwhile.
 */
export function sendProviderError(
  res: Response,
  uid: string,
  feature: string,
  e: unknown,
): void {
  if (!(e instanceof ProviderError)) throw e;
  log.warn(`${feature} uid=${uid} failed: ${e.message}`);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(e.status).json({ error: 'upstream_failed', retryable: e.retryable });
}

/** Trimmed non-empty string from the body, or null. */
export function readString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
