import { config } from '../config';
import { log } from '../log';
import { ProviderError, upstreamError } from './types';
import type { GeneratedImage, ImageProvider, ImageReply, ImageRequest } from './types';

interface ImagesResponse {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  error?: { message?: string } | string;
}

/**
 * xAI images. OpenAI's `/images/generations` shape minus the knobs: no `size`
 * and no `quality` — grok-2-image picks its own dimensions, and sending either
 * parameter is a 400. `n` goes up to 10, and the model always rewrites the
 * prompt, which it returns as `revised_prompt`.
 */
export const grokImageProvider: ImageProvider = {
  name: 'grok',
  model: config.grokImageModel,

  async generate(req: ImageRequest): Promise<ImageReply> {
    const model = config.grokImageModel;

    let response: Response;
    try {
      response = await fetch(`${config.grokBaseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.grokApiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt: req.prompt,
          n: Math.min(Math.max(req.count, 1), 10),
          // Bytes rather than a link, so the client never fetches an expiring
          // xAI URL and the gateway stays the only thing holding the key.
          response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(config.imageTimeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`grok images unreachable: ${(e as Error).message}`, 504, true);
    }

    const json = (await response.json().catch(() => ({}))) as ImagesResponse;

    if (!response.ok) {
      const detail =
        (typeof json.error === 'string' ? json.error : json.error?.message) ||
        `http ${response.status}`;
      log.warn(`grok image error ${response.status}: ${detail}`);
      throw upstreamError('grok', response.status, detail);
    }

    const images: GeneratedImage[] = (json.data || [])
      .map((d): GeneratedImage | null => {
        if (!d.b64_json && !d.url) return null;
        return {
          b64: d.b64_json,
          url: d.url,
          mimeType: 'image/jpeg',
          revisedPrompt: d.revised_prompt,
        };
      })
      .filter((d): d is GeneratedImage => d !== null);

    if (images.length === 0) {
      throw new ProviderError('grok returned no image', 502, true);
    }

    return { images, model };
  },
};
