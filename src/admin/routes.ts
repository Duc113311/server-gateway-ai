import { readFileSync } from 'fs';
import { join } from 'path';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import QRCode from 'qrcode';
import { config } from '../config';
import { log } from '../log';
import { facets, byId, pruneRequestLog, query, stats } from '../store/requestLog';
import {
  consumeRecoveryCode,
  createAccount,
  getAccount,
  markLogin,
  markTotpStepUsed,
  needsSetup,
  verifySecret,
} from './account';
import {
  checkCsrf,
  clearSessionCookie,
  clientIp,
  createSession,
  destroySession,
  loginAllowed,
  promoteSession,
  readSession,
  recordLoginFailure,
  recordLoginSuccess,
  readSession as read,
  setSessionCookie,
} from './session';
import type { Session } from './session';
import { generateSecret, otpauthUri, stepFor, verify } from './totp';

export const adminRouter = Router();

/** Pending enrolments, keyed by the secret shown, so setup survives the QR step. */
const pendingEnrolments = new Map<string, { secret: string; createdAt: number }>();

function page(name: string): string {
  // Read per request rather than cached: the dashboard is low-traffic and this
  // makes an edit to the HTML visible on reload without restarting the server.
  return readFileSync(join(__dirname, 'public', name), 'utf8');
}

function sendHtml(res: Response, html: string, status = 200): void {
  // The status is a parameter rather than set by the caller beforehand: an
  // earlier `res.status(403)` would be silently overwritten here.
  res.status(status).type('html').send(html);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminSession?: Session;
    }
  }
}

/** Every dashboard route: a full session, or nothing. */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = readSession(req);
  if (!session || session.stage !== 'full') {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    res.redirect('/admin/login');
    return;
  }
  req.adminSession = session;
  next();
}

/** State-changing POSTs additionally carry the session's CSRF token. */
function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const session = req.adminSession;
  if (!session || !checkCsrf(session, req.body?.csrf ?? req.headers['x-csrf-token'])) {
    res.status(403).json({ error: 'bad_csrf' });
    return;
  }
  next();
}

// ── Enrolment ───────────────────────────────────────────────────────────────

/**
 * One-time enrolment, closed the moment an account exists.
 *
 * Gated on ADMIN_SETUP_TOKEN as well, because a gateway is reachable from the
 * internet the second it is deployed and an unclaimed admin page is an open
 * door.
 */
adminRouter.get('/setup', (req, res) => {
  if (!needsSetup()) {
    res.redirect('/admin/login');
    return;
  }
  if (!config.adminSetupToken) {
    sendHtml(
      res,
      page('message.html')
        .replace('{{TITLE}}', 'Setup is closed')
        .replace(
          '{{BODY}}',
          'ADMIN_SETUP_TOKEN is empty, so enrolment is disabled. Set it in the ' +
            'environment, restart the gateway, then open this page with ' +
            '<code>?token=YOUR_TOKEN</code>.',
        ),
    );
    return;
  }
  if (req.query.token !== config.adminSetupToken) {
    sendHtml(
      res,
      page('message.html')
        .replace('{{TITLE}}', 'Wrong setup token')
        .replace('{{BODY}}', 'Open this page with <code>?token=YOUR_TOKEN</code>.'),
      403,
    );
    return;
  }
  sendHtml(res, page('setup.html'));
});

/** Step 1: hand out a fresh secret and the QR for it. */
adminRouter.post('/setup/secret', async (req, res) => {
  if (!needsSetup() || req.body?.token !== config.adminSetupToken) {
    res.status(403).json({ error: 'setup_closed' });
    return;
  }
  const username = String(req.body?.username ?? '').trim();
  if (username.length < 3) {
    res.status(400).json({ error: 'bad_username', message: 'at least 3 characters' });
    return;
  }

  const secret = generateSecret();
  pendingEnrolments.set(secret, { secret, createdAt: Date.now() });

  const uri = otpauthUri(secret, username, config.adminIssuer);
  // Rendered here as a data URI: the dashboard must not need an internet
  // round-trip to a QR service, which would also leak the secret.
  const qr = await QRCode.toDataURL(uri, { width: 240, margin: 1 });

  res.json({ secret, uri, qr });
});

/** Step 2: prove the app is enrolled, then the account is written. */
adminRouter.post('/setup/confirm', (req, res) => {
  if (!needsSetup() || req.body?.token !== config.adminSetupToken) {
    res.status(403).json({ error: 'setup_closed' });
    return;
  }

  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const secret = String(req.body?.secret ?? '');
  const code = String(req.body?.code ?? '');

  if (username.length < 3) {
    res.status(400).json({ error: 'bad_username', message: 'at least 3 characters' });
    return;
  }
  if (password.length < 10) {
    res.status(400).json({
      error: 'weak_password',
      message: 'at least 10 characters — this is the only thing between the internet and your logs',
    });
    return;
  }
  if (!pendingEnrolments.has(secret)) {
    res.status(400).json({ error: 'unknown_secret', message: 'restart the setup' });
    return;
  }

  const verdict = verify(secret, code);
  if (!verdict.valid) {
    res.status(400).json({
      error: 'bad_code',
      message: 'that code did not match — check the phone clock and try the next one',
    });
    return;
  }

  const { recoveryCodes } = createAccount(username, password, secret);
  pendingEnrolments.delete(secret);
  // The step that proved enrolment is burnt, so the same digits cannot be
  // replayed at the login page a moment later.
  markTotpStepUsed(verdict.step!);

  // Enrolment already presented both factors — the password was just set and a
  // live code was verified — so the operator is signed in rather than being
  // bounced to a login page that would reject the code they can still see.
  const session = createSession(username, 'full');
  setSessionCookie(req, res, session);
  markLogin();

  res.json({ ok: true, recoveryCodes });
});

// ── Login ───────────────────────────────────────────────────────────────────

adminRouter.get('/login', (req, res) => {
  if (needsSetup()) {
    res.redirect('/admin/setup');
    return;
  }
  const session = readSession(req);
  if (session?.stage === 'full') {
    res.redirect('/admin');
    return;
  }
  sendHtml(res, page('login.html'));
});

/** Step 1 of login: the password. Succeeds into a pending session only. */
adminRouter.post('/login/password', (req, res) => {
  const ip = clientIp(req);
  const gate = loginAllowed(ip);
  if (!gate.allowed) {
    res.status(429).json({ error: 'locked_out', retryAfter: gate.retryAfter });
    return;
  }

  const account = getAccount();
  const username = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');

  // Both checks run even when the username is wrong, so the response time does
  // not reveal whether the username exists.
  const userOk = account !== null && account.username === username;
  const passOk = account !== null && verifySecret(password, account.passwordHash);

  if (!account || !userOk || !passOk) {
    recordLoginFailure(ip);
    log.warn(`admin login failed (password) from ${ip}`);
    res.status(401).json({ error: 'bad_credentials' });
    return;
  }

  const session = createSession(account.username, 'pending');
  setSessionCookie(req, res, session);
  res.json({ ok: true, next: 'totp' });
});

/** Step 2 of login: the authenticator code, or a recovery code. */
adminRouter.post('/login/totp', (req, res) => {
  const ip = clientIp(req);
  const gate = loginAllowed(ip);
  if (!gate.allowed) {
    res.status(429).json({ error: 'locked_out', retryAfter: gate.retryAfter });
    return;
  }

  const session = readSession(req);
  if (!session || session.stage !== 'pending') {
    res.status(401).json({ error: 'no_pending_login', message: 'start again' });
    return;
  }

  const account = getAccount();
  if (!account) {
    res.status(401).json({ error: 'no_account' });
    return;
  }

  const code = String(req.body?.code ?? '').trim();
  const useRecovery = req.body?.recovery === true;

  if (useRecovery) {
    if (!consumeRecoveryCode(code)) {
      recordLoginFailure(ip);
      res.status(401).json({ error: 'bad_recovery_code' });
      return;
    }
  } else {
    const verdict = verify(account.totpSecret, code);
    if (!verdict.valid) {
      recordLoginFailure(ip);
      log.warn(`admin login failed (totp) from ${ip}`);
      res.status(401).json({ error: 'bad_code' });
      return;
    }
    // A code stays valid for its whole 30-second step, so without this the
    // same digits could be replayed by anyone who saw them.
    if (verdict.step! <= account.lastTotpStep) {
      recordLoginFailure(ip);
      log.warn(`admin login rejected: TOTP step ${verdict.step} replayed from ${ip}`);
      res.status(401).json({ error: 'code_already_used' });
      return;
    }
    markTotpStepUsed(verdict.step!);
  }

  const full = promoteSession(session);
  setSessionCookie(req, res, full);
  recordLoginSuccess(ip);
  markLogin();
  log.info(`admin signed in from ${ip}`);
  res.json({ ok: true });
});

adminRouter.post('/logout', (req, res) => {
  const session = read(req);
  if (session) destroySession(session.id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Dashboard ───────────────────────────────────────────────────────────────

adminRouter.get('/', requireAdmin, (_req, res) => {
  sendHtml(res, page('dashboard.html'));
});

adminRouter.get('/app.css', (_req, res) => {
  res.type('css').send(page('app.css'));
});

adminRouter.get('/app.js', requireAdmin, (_req, res) => {
  res.type('js').send(page('app.js'));
});

/** Everything the dashboard needs to bootstrap: identity, CSRF, filter values. */
adminRouter.get('/api/me', requireAdmin, (req, res) => {
  const account = getAccount();
  res.json({
    username: req.adminSession!.username,
    csrf: req.adminSession!.csrf,
    lastLoginAt: account?.lastLoginAt,
    recoveryCodesLeft: account?.recoveryHashes.length ?? 0,
    promptsLogged: config.adminLogPrompts,
    retentionDays: config.adminLogRetentionDays,
    facets: facets(),
  });
});

function parseQuery(req: Request) {
  const n = (v: unknown): number | undefined => {
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  const s = (v: unknown): string | undefined => {
    const x = typeof v === 'string' ? v.trim() : '';
    return x === '' ? undefined : x;
  };
  return {
    from: n(req.query.from),
    to: n(req.query.to),
    uid: s(req.query.uid),
    feature: s(req.query.feature),
    model: s(req.query.model),
    status: s(req.query.status),
    search: s(req.query.search),
    limit: n(req.query.limit),
    offset: n(req.query.offset),
  };
}

adminRouter.get('/api/requests', requireAdmin, (req, res) => {
  res.json(query(parseQuery(req)));
});

adminRouter.get('/api/stats', requireAdmin, (req, res) => {
  res.json(stats(parseQuery(req)));
});

adminRouter.get('/api/requests/:id', requireAdmin, (req, res) => {
  const entry = byId(req.params.id);
  if (!entry) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(entry);
});

/** CSV of the current filter, for taking numbers into a spreadsheet. */
adminRouter.get('/api/export.csv', requireAdmin, (req, res) => {
  const { entries } = query({ ...parseQuery(req), limit: 500, offset: 0 });
  const cell = (v: unknown): string => {
    const s = v === undefined || v === null ? '' : String(v);
    return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  };
  const header = [
    'time', 'uid', 'feature', 'provider', 'model',
    'input_tokens', 'output_tokens', 'latency_ms', 'status', 'error', 'prompt',
  ];
  const rows = entries.map((e) =>
    [
      new Date(e.ts).toISOString(), e.uid, e.feature, e.provider, e.model,
      e.inputTokens, e.outputTokens, e.latencyMs, e.status, e.errorCode ?? '',
      e.prompt ?? '',
    ]
      .map(cell)
      .join(','),
  );
  res
    .type('text/csv')
    .set('content-disposition', 'attachment; filename="gateway-requests.csv"')
    .send([header.join(','), ...rows].join('\n'));
});

adminRouter.post('/api/prune', requireAdmin, requireCsrf, (_req, res) => {
  pruneRequestLog();
  res.json({ ok: true });
});
