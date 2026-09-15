import { Readable } from 'stream';
import { Router } from 'express';
import { requireAuth } from '../auth';
import { config } from '../config';
import { log } from '../log';
import { videoProvider } from '../providers';
import { createJob, getJob, updateJob } from '../videoJobs';
import { allow, readString, sendProviderError } from './respond';

export const videoRouter = Router();

/**
 * Video is start-then-poll, not one request: a render takes one to several
 * minutes, which outlives any sane HTTP timeout and every mobile radio nap.
 *
 *   POST /v1/video          -> { jobId, status: "pending", pollAfter }
 *   GET  /v1/video/:id      -> { status, url? }   // url is on this gateway
 *   GET  /v1/video/:id/content -> the mp4 bytes
 *
 * The clip is streamed back through the gateway because both upstreams gate
 * their output behind the API key, which must never reach the app.
 */

videoRouter.post('/video', requireAuth, async (req, res) => {
  const uid = req.uid!;

  if (!videoProvider) {
    res.status(404).json({ error: 'feature_disabled', feature: 'video' });
    return;
  }
  if (!allow(res, uid, 'video')) return;

  const prompt = readString(req.body?.prompt);
  if (!prompt) {
    res.status(400).json({ error: 'empty_prompt', message: 'prompt is required' });
    return;
  }
  if (prompt.length > config.maxVideoPromptChars) {
    res.status(400).json({
      error: 'prompt_too_long',
      message: `prompt exceeds ${config.maxVideoPromptChars} characters`,
    });
    return;
  }

  const seconds = Number(req.body?.seconds);
  try {
    const handle = await videoProvider.start({
      prompt,
      size: readString(req.body?.size) ?? undefined,
      seconds: Number.isFinite(seconds) ? Math.floor(seconds) : undefined,
    });
    const job = createJob(uid, handle);

    log.info(
      `video uid=${uid} provider=${videoProvider.name} model=${handle.model} ` +
        `job=${job.id} started`,
    );

    res.status(202).json({
      jobId: job.id,
      status: 'pending',
      model: handle.model,
      provider: videoProvider.name,
      // Renders never finish faster than this, so polling sooner only burns
      // the caller's battery.
      pollAfter: 10,
    });
  } catch (e) {
    sendProviderError(res, uid, 'video', e);
  }
});

videoRouter.get('/video/:id', requireAuth, async (req, res) => {
  const uid = req.uid!;

  if (!videoProvider) {
    res.status(404).json({ error: 'feature_disabled', feature: 'video' });
    return;
  }

  const job = getJob(req.params.id, uid);
  if (!job) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }

  // A finished job is answered from the store: re-polling a completed render
  // is a call the provider would still charge for on some plans.
  if (job.status !== 'pending') {
    res.json({
      status: job.status,
      url: job.status === 'ready' ? `/v1/video/${job.id}/content` : undefined,
      error: job.status === 'failed' ? 'render_failed' : undefined,
    });
    return;
  }

  try {
    const progress = await videoProvider.poll(job.handle);
    updateJob(job, {
      status: progress.status,
      upstreamUrl: progress.url,
      error: progress.error,
    });

    if (progress.status === 'failed') {
      // The provider's wording can name the model or the moderation rule that
      // tripped, so it stays in the log.
      log.warn(`video uid=${uid} job=${job.id} failed: ${progress.error}`);
      res.json({ status: 'failed', error: 'render_failed' });
      return;
    }
    if (progress.status === 'ready') {
      log.info(
        `video uid=${uid} job=${job.id} ready in ${Date.now() - job.createdAt}ms`,
      );
      res.json({ status: 'ready', url: `/v1/video/${job.id}/content` });
      return;
    }

    res.json({ status: 'pending', pollAfter: 10 });
  } catch (e) {
    sendProviderError(res, uid, 'video', e);
  }
});

videoRouter.get('/video/:id/content', requireAuth, async (req, res) => {
  const uid = req.uid!;

  if (!videoProvider) {
    res.status(404).json({ error: 'feature_disabled', feature: 'video' });
    return;
  }

  const job = getJob(req.params.id, uid);
  if (!job || job.status !== 'ready' || !job.upstreamUrl) {
    res.status(404).json({ error: 'job_not_ready' });
    return;
  }

  try {
    const upstream = videoProvider.download
      ? await videoProvider.download(job.handle, job.upstreamUrl)
      : await fetch(job.upstreamUrl);

    if (!upstream.ok || !upstream.body) {
      log.warn(`video uid=${uid} job=${job.id} download http ${upstream.status}`);
      res.status(502).json({ error: 'upstream_failed', retryable: true });
      return;
    }

    res.status(200).set({
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'cache-control': 'private, max-age=3600',
    });
    const length = upstream.headers.get('content-length');
    if (length) res.set('content-length', length);

    // Piped rather than buffered: a clip is tens of megabytes and holding one
    // in memory per concurrent viewer is how a small instance falls over.
    Readable.fromWeb(upstream.body as never).pipe(res);
  } catch (e) {
    sendProviderError(res, uid, 'video', e);
  }
});
