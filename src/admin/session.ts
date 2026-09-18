import { randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { config } from '../config';
import { log } from '../log';

export const SESSION_COOKIE = 'gw_admin';

/**
 * A session between the password step and the 2FA step is 'pending': it proves
 * the password only, and every dashboard route rejects it. Promoting it to
 * 'full' is what the TOTP code buys.
 */
export type SessionStage = 'pending' | 'full';

interface Session {
  id: string;
  stage: SessionStage;
  username: string;
  createdAt: number;
  expiresAt: number;
  /** Per-session CSRF token, checked on every state-changing POST. */
  csrf: string;
}

/**
 * Sessions live in memory, so a restart signs the operator out. That is the
 * right trade for an admin surface: one login is cheap, and a stolen session
 * file is not.
 */
const sessions = new Map<string, Session>();

function newId(): string {
  return randomBytes(32).toString('base64url');
}

export function createSession(username: string, stage: SessionStage): Session {
  const now = Date.now();
  const ttl = stage === 'pending' ? config.adminPendingTtlMs : config.adminSessionTtlMs;
  const session: Session = {
    id: newId(),
    stage,
    username,
    createdAt: now,
    expiresAt: now + ttl,
    csrf: randomBytes(24).toString('base64url'),
  };
  sessions.set(session.id, session);
  return session;
}

/** Promotes a pending session and rotates its id, so the pre-2FA id is useless. */
export function promoteSession(session: Session): Session {
  sessions.delete(session.id);
  const promoted: Session = {
    ...session,
    id: newId(),
    stage: 'full',
    expiresAt: Date.now() + config.adminSessionTtlMs,
    csrf: randomBytes(24).toString('base64url'),
  };
  sessions.set(promoted.id, promoted);
  return promoted;
}

export function destroySession(id: string): void {
  sessions.delete(id);
}

export function readSession(req: Request): Session | null {
  const raw = req.headers.cookie;
  if (!raw) return null;

  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== SESSION_COOKIE) continue;
    const session = sessions.get(decodeURIComponent(rest.join('=')));
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      sessions.delete(session.id);
      return null;
    }
    return session;
  }
  return null;
}

export function setSessionCookie(req: Request, res: Response, session: Session): void {
  // Secure is set whenever the request did not arrive over plain http on a
  // loopback address — a Secure cookie on http://localhost is silently dropped
  // by the browser, which would make local development impossible.
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = req.hostname || '';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const secure = proto === 'https' || !isLocal;

  const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000);
  res.append(
    'set-cookie',
    [
      `${SESSION_COOKIE}=${encodeURIComponent(session.id)}`,
      'Path=/admin',
      'HttpOnly',
      // Strict, not Lax: nothing links into the dashboard from elsewhere, and
      // it is the cheapest CSRF defence there is.
      'SameSite=Strict',
      secure ? 'Secure' : '',
      `Max-Age=${Math.max(0, maxAge)}`,
    ]
      .filter(Boolean)
      .join('; '),
  );
}

export function clearSessionCookie(res: Response): void {
  res.append('set-cookie', `${SESSION_COOKIE}=; Path=/admin; HttpOnly; Max-Age=0`);
}

export function checkCsrf(session: Session, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const a = Buffer.from(session.csrf);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function pruneSessions(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id);
  }
}

// ── Brute-force guard ───────────────────────────────────────────────────────

interface Attempts {
  count: number;
  firstAt: number;
  lockedUntil?: number;
}

const attempts = new Map<string, Attempts>();

/**
 * Locks an origin out after repeated failures.
 *
 * Keyed by client IP: the username is not part of the key, so guessing many
 * usernames from one address does not buy extra tries. There is exactly one
 * admin account anyway.
 */
export function loginAllowed(ip: string): { allowed: boolean; retryAfter?: number } {
  const a = attempts.get(ip);
  if (!a?.lockedUntil) return { allowed: true };
  if (Date.now() < a.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((a.lockedUntil - Date.now()) / 1000) };
  }
  attempts.delete(ip);
  return { allowed: true };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  let a = attempts.get(ip);
  // The counter is a rolling window, so someone who mistypes once a day is
  // never locked out.
  if (!a || now - a.firstAt > config.adminLockoutWindowMs) {
    a = { count: 0, firstAt: now };
    attempts.set(ip, a);
  }
  a.count++;
  if (a.count >= config.adminMaxLoginAttempts) {
    a.lockedUntil = now + config.adminLockoutMs;
    log.warn(`admin login locked out for ${ip} after ${a.count} failures`);
  }
}

export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip);
}

/** Behind Cloud Run or any proxy, the real client is the first XFF hop. */
export function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export type { Session };
