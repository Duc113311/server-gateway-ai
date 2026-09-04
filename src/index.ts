import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { assertConfig, config } from './config';
import { log } from './log';
import { provider } from './providers';
import { pruneRateBuckets } from './rateLimit';
import { chatRouter } from './routes/chat';
import { healthRouter } from './routes/health';

assertConfig();

const app = express();

// Small ceiling on purpose: the per-message and per-history caps in prompt.ts
// mean a legitimate chat body is a couple of KB at most.
app.use(express.json({ limit: '64kb' }));

app.use(healthRouter);
app.use('/v1', chatRouter);

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
      `(provider=${provider.name} model=${provider.model} auth=${config.authMode})`,
  );
  if (config.authMode === 'none') {
    log.warn('AUTH_MODE=none — anyone who reaches this port can spend your tokens');
  }
});

// Hourly, so an instance that has served many one-off users doesn't hold every
// uid it has ever seen.
const pruneTimer = setInterval(() => pruneRateBuckets(), 60 * 60 * 1000);
pruneTimer.unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, closing`);
    server.close(() => process.exit(0));
  });
}
