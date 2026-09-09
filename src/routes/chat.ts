import { Router } from 'express';
import { requireAuth } from '../auth';
import { config } from '../config';
import { log } from '../log';
import {
  cardToText,
  parseCard,
  parseCardPartial,
  parseLocale,
  parseTurns,
  systemPrompt,
  ValidationError,
} from '../prompt';
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
  const wantStream = req.body?.stream === true && typeof provider.chatStream === 'function';
  try {
    // Streaming path (the app's chat controller). The model streams the JSON
    // card token by token; we buffer it, parse a best-effort card after each
    // chunk, and push the growing card as SSE `card` frames so the app can fill
    // it in live. Headers are held back until the first usable card, so an
    // upstream failure before any output still maps to a real status code.
    if (wantStream) {
      let model = provider.model;
      let inputTokens = 0;
      let outputTokens = 0;
      let buffer = '';
      let lastSent = '';

      const openStream = () => {
        if (res.headersSent) return;
        res.status(200).set({
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
      };

      for await (const chunk of provider.chatStream!({
        system: systemPrompt(locale),
        turns,
        maxOutputTokens: config.maxOutputTokens,
      })) {
        if (chunk.done) {
          model = chunk.model ?? model;
          inputTokens = chunk.inputTokens ?? inputTokens;
          outputTokens = chunk.outputTokens ?? outputTokens;
          break;
        }
        if (!chunk.delta) continue;
        buffer += chunk.delta;

        // Only emit when the partial parses to something new — a half-written
        // token yields the same card as the last frame, so it is skipped.
        const partial = parseCardPartial(buffer);
        if (!partial) continue;
        const snapshot = JSON.stringify(partial);
        if (snapshot === lastSent) continue;
        lastSent = snapshot;
        openStream();
        res.write(`data: ${JSON.stringify({ card: partial })}\n\n`);
      }

      // The final, strict parse wins over the last partial; fall back to it.
      const finalCard = parseCard(buffer) ?? parseCardPartial(buffer);
      if (!res.headersSent && !finalCard) {
        res.status(502).json({ error: 'upstream_failed', retryable: true });
        return;
      }
      openStream();

      res.write(
        `data: ${JSON.stringify({
          done: true,
          card: finalCard,
          reply: finalCard ? cardToText(finalCard) : buffer,
          model,
          usage: { input: inputTokens, output: outputTokens },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      log.info(
        `chat uid=${uid} provider=${provider.name} model=${model} ` +
          `in=${inputTokens} out=${outputTokens} ${Date.now() - startedAt}ms stream`,
      );
      return;
    }

    const reply = await provider.chat({
      system: systemPrompt(locale),
      turns,
      maxOutputTokens: config.maxOutputTokens,
    });

    log.info(
      `chat uid=${uid} provider=${provider.name} model=${reply.model} ` +
        `in=${reply.inputTokens} out=${reply.outputTokens} ${Date.now() - startedAt}ms`,
    );

    // The model answers as a JSON card; parse it here so the app gets a clean
    // shape and a plain-text fallback, never a raw JSON blob to show on failure.
    const card = parseCard(reply.text);
    res.json({
      card,
      reply: card ? cardToText(card) : reply.text,
      model: reply.model,
      usage: { input: reply.inputTokens, output: reply.outputTokens },
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      // The upstream's own message can name the model or the key, so it stays
      // in the log and the client only learns whether retrying is worthwhile.
      log.warn(`chat uid=${uid} failed: ${e.message}`);
      // Once the SSE stream is open, the status line is already sent — the
      // client reads a failure as an in-band error frame, not an HTTP status.
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: 'upstream_failed', retryable: e.retryable })}\n\n`);
        res.end();
      } else {
        res.status(e.status).json({ error: 'upstream_failed', retryable: e.retryable });
      }
      return;
    }
    throw e;
  }
});
