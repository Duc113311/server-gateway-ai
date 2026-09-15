import { Router } from 'express';
import { config } from '../config';
import { imageProvider, provider, translateProvider, videoProvider } from '../providers';

export const healthRouter = Router();

/**
 * Unauthenticated liveness probe for the host's health check.
 *
 * Reports which upstream serves each feature, and never whether a key is set —
 * that is exactly the kind of detail a probe endpoint should not leak. The
 * `features` block is also what the app reads to know whether to show the
 * image, video or translate entry points at all.
 */
healthRouter.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    provider: provider.name,
    model: provider.model,
    authMode: config.authMode,
    features: {
      chat: { enabled: true, provider: provider.name, model: provider.model },
      image: imageProvider
        ? { enabled: true, provider: imageProvider.name, model: imageProvider.model }
        : { enabled: false },
      video: videoProvider
        ? { enabled: true, provider: videoProvider.name, model: videoProvider.model }
        : { enabled: false },
      translate: translateProvider
        ? {
            enabled: true,
            provider: translateProvider.name,
            model: translateProvider.model,
          }
        : { enabled: false },
    },
  });
});
