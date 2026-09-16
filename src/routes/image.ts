import { Router } from 'express';
import { requireAuth } from '../auth';
import { config } from '../config';
import { log } from '../log';
import { imageProvider } from '../providers';
import { record } from '../store/requestLog';
import { allow, readString, sendProviderError } from './respond';

export const imageRouter = Router();

/**
 * POST /v1/image
 *
 * Body:  { "prompt": "...", "n": 1, "size": "1024x1024", "quality": "standard" }
 * Reply: { "images": [{ "b64": "...", "mimeType": "image/png" }],
 *          "model": "...", "provider": "..." }
 *
 * The bytes come back inline rather than as a provider URL: every upstream here
 * either expires its links within the hour or gates them behind the API key.
 */
imageRouter.post('/image', requireAuth, async (req, res) => {
  const uid = req.uid!;

  if (!imageProvider) {
    res.status(404).json({ error: 'feature_disabled', feature: 'image' });
    return;
  }
  if (!allow(res, uid, 'image')) return;

  const prompt = readString(req.body?.prompt);
  if (!prompt) {
    res.status(400).json({ error: 'empty_prompt', message: 'prompt is required' });
    return;
  }
  if (prompt.length > config.maxImagePromptChars) {
    res.status(400).json({
      error: 'prompt_too_long',
      message: `prompt exceeds ${config.maxImagePromptChars} characters`,
    });
    return;
  }

  const requested = Number(req.body?.n);
  const count = Math.min(
    Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1,
    config.maxImagesPerRequest,
  );
  const size = readString(req.body?.size) ?? '1024x1024';
  const quality = readString(req.body?.quality) ?? undefined;

  const startedAt = Date.now();
  try {
    const reply = await imageProvider.generate({ prompt, count, size, quality });

    log.info(
      `image uid=${uid} provider=${imageProvider.name} model=${reply.model} ` +
        `n=${reply.images.length} ${Date.now() - startedAt}ms`,
    );

    record({
      uid,
      feature: 'image',
      provider: imageProvider.name,
      model: reply.model,
      // Image models bill per picture, not per token, and none of them report
      // usage — so these stay zero rather than being invented.
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      prompt,
      replyPreview: `${reply.images.length} image(s) at ${size}`,
    });

    res.json({
      images: reply.images,
      model: reply.model,
      provider: imageProvider.name,
    });
  } catch (e) {
    record({
      uid,
      feature: 'image',
      provider: imageProvider.name,
      model: imageProvider.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      errorCode: 'upstream_failed',
      prompt,
    });
    sendProviderError(res, uid, 'image', e);
  }
});
