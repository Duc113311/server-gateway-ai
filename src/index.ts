import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { assertConfig, config } from './config';
import { log } from './log';
import { imageProvider, provider, translateProvider, videoProvider } from './providers';
import { pruneRateBuckets } from './rateLimit';
import { chatRouter } from './routes/chat';
import { healthRouter } from './routes/health';
import { imageRouter } from './routes/image';
import { translateRouter } from './routes/translate';
import { videoRouter } from './routes/video';
import { pruneVideoJobs } from './videoJobs';

assertConfig();

const app = express();

// Small ceiling on purpose: the per-message and per-history caps in prompt.ts
// mean a legitimate chat body is a couple of KB at most, and a translate batch
// is capped by MAX_TRANSLATE_CHARS well under this.
app.use(express.json({ limit: '256kb' }));

app.use(healthRouter);
app.use('/v1', chatRouter);
// Mounted whatever the provider setting is: a disabled feature answers 404
// `feature_disabled`, which tells the app to hide the entry point, rather than
// a bare 404 that looks like a deploy went wrong.
app.use('/v1', imageRouter);
app.use('/v1', videoRouter);
app.use('/v1', translateRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Four arguments is what marks this as Express's error handler — dropping
// `next` silently turns it back into ordinary middleware.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error(`unhandled: ${err.stack || err.message}`);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal' });
});

const server = app.listen(config.port, () => {
  log.info(
    `gateway listening on :${config.port} ` +
      `(chat=${provider.name}/${provider.model} auth=${config.authMode})`,
  );
  log.info(
    `features: image=${imageProvider ? `${imageProvider.name}/${imageProvider.model}` : 'off'} ` +
      `video=${videoProvider ? `${videoProvider.name}/${videoProvider.model}` : 'off'} ` +
      `translate=${translateProvider ? translateProvider.name : 'off'}`,
  );
  if (config.authMode === 'none') {
    log.warn('AUTH_MODE=none — anyone who reaches this port can spend your tokens');
  }
});

// Hourly, so an instance that has served many one-off users doesn't hold every
// uid it has ever seen, nor every video job it has ever started.
const pruneTimer = setInterval(() => {
  pruneRateBuckets();
  pruneVideoJobs();
}, 60 * 60 * 1000);
pruneTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, closing`);
    server.close(() => process.exit(0));
  });
}
