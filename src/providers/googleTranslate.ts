import { config } from '../config';
import { log } from '../log';
import { ProviderError, upstreamError } from './types';
import type { TranslateProvider, TranslateReply, TranslateRequest } from './types';

interface TranslateResponse {
  data?: {
    translations?: { translatedText?: string; detectedSourceLanguage?: string }[];
  };
  error?: { message?: string };
}

/**
 * v2 returns HTML entities even with `format=text` — an apostrophe comes back
 * as `&#39;` — so the five that actually occur are decoded before the string
 * reaches the app.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Google Cloud Translation v2. Billed per character rather than per token, so
 * it is far cheaper than a chat model for bulk strings, it needs no prompt to
 * behave, and it covers 100+ languages — but it only translates, so anything
 * needing tone or context still wants TRANSLATE_PROVIDER=model.
 *
 * The key is an API key restricted to the Translation API, not a service
 * account, and it goes in the query string because v2 accepts nothing else.
 */
export const googleTranslateProvider: TranslateProvider = {
  name: 'google',
  model: 'translate-v2',

  async translate(req: TranslateRequest): Promise<TranslateReply> {
    const body: Record<string, unknown> = {
      q: req.texts,
      target: req.to,
      format: 'text',
    };
    if (req.from && req.from !== 'auto') body.source = req.from;

    let response: Response;
    try {
      response = await fetch(
        `${config.googleTranslateBaseUrl}?key=${encodeURIComponent(config.googleTranslateApiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        },
      );
    } catch (e) {
      throw new ProviderError(
        `google translate unreachable: ${(e as Error).message}`,
        504,
        true,
      );
    }

    const json = (await response.json().catch(() => ({}))) as TranslateResponse;

    if (!response.ok) {
      const detail = json.error?.message || `http ${response.status}`;
      // The URL carries the key, so only the message is logged, never the URL.
      log.warn(`google translate error ${response.status}: ${detail}`);
      throw upstreamError('google-translate', response.status, detail);
    }

    const items = json.data?.translations || [];
    if (items.length !== req.texts.length) {
      throw new ProviderError(
        `google translate returned ${items.length} of ${req.texts.length} strings`,
        502,
        true,
      );
    }

    return {
      translations: items.map((t) => decodeEntities(t.translatedText || '')),
      detected: items[0]?.detectedSourceLanguage,
      model: 'translate-v2',
    };
  },
};
