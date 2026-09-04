import { Router } from 'express';
import { requireAuth } from '../auth';
import { config } from '../config';
import { log } from '../log';
import { parseLocale, parseTurns, systemPrompt, ValidationError } from '../prompt';
import { provider, ProviderError } from '../providers';
import { checkRate } from '../rateLimit';

export const chatRouter = Router();

/**
 * POST /v1/chat
 *
 * Body:  { "messages": [{ "role": "user" | "assistant", "content": "..." }],
 *          "locale": "vi_VN" }
 * Reply: { "reply": "...", "model": "...", "usage": { "input": 0, "output": 0 } }
 */
chatRouter.post('/chat', requireAuth, async (req, res) => {
  const uid = req.uid!;

  const verdict = checkRate(uid);
  if (!verdict.allowed) {
    res
      .status(429)
      .set('retry-after', String(verdict.retryAfter ?? 60))
      .json({ error: 'rate_limited', scope: verdict.scope, retryAfter: verdict.retryAfter });
    return;
  }

  let turns;
  let locale;
  try {
    turns = parseTurns(req.body?.messages);
    locale = parseLocale(req.body?.locale);
  } catch (e) {
    if (e instanceof ValidationError) {
      res.status(400).json({ error: e.code, message: e.message });
      return;
    }
    throw e;
  }

  const startedAt = Date.now();
  try {
    const reply = await provider.chat({
      system: systemPrompt(locale),
      turns,
      maxOutputTokens: config.maxOutputTokens,
    });

    log.info(
      `chat uid=${uid} provider=${provider.name} model=${reply.model} ` +
        `in=${reply.inputTokens} out=${reply.outputTokens} ${Date.now() - startedAt}ms`,
    );

    res.json({
      reply: reply.text,
      model: reply.model,
      usage: { input: reply.inputTokens, output: reply.outputTokens },
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      // The upstream's own message can name the model or the key, so it stays
      // in the log and the client only learns whether retrying is worthwhile.
      log.warn(`chat uid=${uid} failed: ${e.message}`);
      res.status(e.status).json({ error: 'upstream_failed', retryable: e.retryable });
      return;
    }
    throw e;
  }
});
