import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * RFC 6238 TOTP, the flavour Google Authenticator speaks: HMAC-SHA1, 6 digits,
 * a 30-second step. Implemented here rather than pulled in, because it is
 * thirty lines and an authentication dependency is a supply-chain risk you
 * carry forever.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, which is the alphabet authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The counter a timestamp falls in. Exposed so replay can be tracked by step. */
export function stepFor(atMs = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function codeFor(secret: string, step: number): string {
  const key = base32Decode(secret);

  // The counter is a big-endian 64-bit integer; writing it as two 32-bit
  // halves avoids needing BigInt for a value that never exceeds 2^53.
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export interface TotpVerdict {
  valid: boolean;
  /** The step the code belonged to, so the caller can reject a replay of it. */
  step?: number;
}

/**
 * Checks a code against the steps around now.
 *
 * [window] of 1 accepts the previous and next step as well as the current one,
 * which covers a phone clock that has drifted by up to 30 seconds. Widening it
 * further trades real security for convenience.
 *
 * The caller must also reject a step it has already accepted — this function
 * reports which step matched but keeps no state of its own.
 */
export function verify(
  secret: string,
  code: string,
  window = 1,
  atMs = Date.now(),
): TotpVerdict {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== TOTP_DIGITS) return { valid: false };

  const now = stepFor(atMs);
  for (let drift = -window; drift <= window; drift++) {
    const step = now + drift;
    const expected = codeFor(secret, step);
    // Both are fixed-length digit strings, so a timing-safe compare is cheap
    // and removes the side channel a plain === would leave.
    const a = Buffer.from(expected);
    const b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return { valid: true, step };
  }
  return { valid: false };
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label carries the issuer twice — once as the `Issuer:Account` prefix and
 * once as a parameter — because older apps read only one of the two.
 */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
