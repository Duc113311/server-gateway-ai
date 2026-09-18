import { Router } from 'express';
import { requireAuth } from '../auth';
import { config } from '../config';
import { log } from '../log';
import { parseLocale } from '../prompt';
import { translateProvider } from '../providers';
import { record } from '../store/requestLog';
import { allow, readString, sendProviderError } from './respond';

export const translateRouter = Router();

/**
 * POST /v1/translate
 *
 * Body:  { "text": "..." }                    // or "texts": ["...", "..."]
 *        { "to": "vi", "from": "auto" }
 * Reply: { "translation": "...", "translations": ["..."], "detected": "en",
 *          "model": "...", "provider": "..." }
 *
 * Batching is the point: one call with fifty strings costs a fraction of fifty
 * calls, because the system prompt is sent once instead of fifty times.
 */
translateRouter.post('/translate', requireAuth, async (req, res) => {
  const uid = req.uid!;

  if (!translateProvider) {
    res.status(404).json({ error: 'feature_disabled', feature: 'translate' });
    return;
  }
  if (!allow(res, uid, 'translate')) return;

  // `text` and `texts` are the same call; the singular form just saves the
  // caller an array and gets a `translation` back instead of a list.
  const single = readString(req.body?.text);
  const rawTexts: unknown = req.body?.texts;
  const texts: string[] = single
    ? [single]
    : Array.isArray(rawTexts)
      ? rawTexts.filter((t): t is string => typeof t === 'string')
      : [];

  if (texts.length === 0) {
    res.status(400).json({
      error: 'empty_texts',
      message: 'send "text" (string) or "texts" (non-empty string array)',
    });
    return;
  }
  if (Array.isArray(rawTexts) && !single && texts.length !== rawTexts.length) {
    res.status(400).json({
      error: 'bad_texts',
      message: 'every item in "texts" must be a string',
    });
    return;
  }
  if (texts.length > config.maxTranslateItems) {
    res.status(400).json({
      error: 'too_many_texts',
      message: `at most ${config.maxTranslateItems} strings per call`,
    });
    return;
  }

  const totalChars = texts.reduce((n, t) => n + t.length, 0);
  if (totalChars > config.maxTranslateChars) {
    res.status(400).json({
      error: 'texts_too_long',
      message: `the batch exceeds ${config.maxTranslateChars} characters`,
    });
    return;
  }

  const to = readString(req.body?.to);
  if (!to) {
    res.status(400).json({ error: 'missing_target', message: '"to" is required' });
    return;
  }
  // Same guard as the chat locale: the value is interpolated into a prompt on
  // the model path and into a query on the Google path.
  const target = parseLocale(to);
  if (target === 'en' && to.toLowerCase() !== 'en') {
    res.status(400).json({ error: 'bad_target', message: `unusable target "${to}"` });
    return;
  }
  const from = readString(req.body?.from);
  const source = from ? parseLocale(from) : undefined;

  const startedAt = Date.now();
  try {
    const reply = await translateProvider.translate({
      texts,
      to: target,
      from: from === 'auto' ? 'auto' : source,
    });

    log.info(
      `translate uid=${uid} provider=${translateProvider.name} ` +
        `model=${reply.model} n=${texts.length} chars=${totalChars} ` +
        `${Date.now() - startedAt}ms`,
    );

    record({
      uid,
      feature: 'translate',
      provider: translateProvider.name,
      model: reply.model,
      inputTokens: reply.inputTokens ?? 0,
      outputTokens: reply.outputTokens ?? 0,
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      locale: target,
      prompt: texts.join(' | '),
      replyPreview: reply.translations.join(' | '),
    });

    res.json({
      // The singular field is present only when the caller asked in the
      // singular, so a batch can never be read as one string by accident.
      translation: single ? reply.translations[0] : undefined,
      translations: reply.translations,
      detected: reply.detected,
      model: reply.model,
      provider: translateProvider.name,
      usage: reply.inputTokens
        ? { input: reply.inputTokens, output: reply.outputTokens }
        : undefined,
    });
  } catch (e) {
    record({
      uid,
      feature: 'translate',
      provider: translateProvider.name,
      model: translateProvider.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      errorCode: 'upstream_failed',
      locale: target,
      prompt: texts.join(' | '),
    });
    sendProviderError(res, uid, 'translate', e);
  }
});
