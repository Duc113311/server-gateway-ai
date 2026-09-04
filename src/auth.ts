import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { getAuth } from './firebase';
import { log } from './log';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Firebase uid of the caller, set by [requireAuth]. */
      uid?: string;
    }
  }
}

/**
 * Rejects anything without a valid Firebase ID token.
 *
 * The uid it resolves is what the quota is counted against, so an anonymous
 * Firebase sign-in is enough — the app does not need a real account, it just
 * needs a stable identity the gateway can bill.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (config.authMode === 'none') {
    // Local development: everyone shares one bucket so the quota still applies.
    req.uid = 'anonymous-dev';
    next();
    return;
  }

  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }

  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    // Expired tokens are routine — the client refreshes and retries — so this
    // is a debug line, not a warning.
    log.debug(`rejected token: ${(e as Error).message}`);
    res.status(401).json({ error: 'invalid_token' });
  }
}
