import { Router } from 'express';
import { config } from '../config';
import { provider } from '../providers';

export const healthRouter = Router();

/**
 * Unauthenticated liveness probe for the host's health check.
 *
 * Reports which upstream is configured but never whether a key is set — that
 * is exactly the kind of detail a probe endpoint should not leak.
 */
healthRouter.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    provider: provider.name,
    model: provider.model,
    authMode: config.authMode,
  });
});
