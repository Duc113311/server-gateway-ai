import { config } from '../config';
import { log } from '../log';
import { ProviderError, upstreamError } from './types';
import type { GeneratedImage, ImageProvider, ImageReply, ImageRequest } from './types';

interface ImagesResponse {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  error?: { message?: string };
}

/** Sizes each model will accept; anything else is a 400 from the upstream. */
const GPT_IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);
const DALLE3_SIZES = new Set(['1024x1024', '1792x1024', '1024x1792']);

/**
 * OpenAI images. Two model families behind one endpoint:
 *
 * - `gpt-image-1` always returns base64 and rejects `response_format`;
 *   quality is low|medium|high|auto.
 * - `dall-e-3` takes `response_format`, caps `n` at 1, and uses
 *   quality standard|hd with its own size list.
 */
export const openaiImageProvider: ImageProvider = {
  name: 'openai',
  model: config.openaiImageModel,

  async generate(req: ImageRequest): Promise<ImageReply> {
    const model = config.openaiImageModel;
    const isDalle = model.startsWith('dall-e');
    const allowed = isDalle ? DALLE3_SIZES : GPT_IMAGE_SIZES;

    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      // dall-e-3 renders one image per call however many you ask for.
      n: isDalle ? 1 : req.count,
      size: allowed.has(req.size) ? req.size : '1024x1024',
    };
    if (req.quality) {
      body.quality = isDalle
        ? req.quality === 'hd'
          ? 'hd'
          : 'standard'
        : req.quality === 'hd'
          ? 'high'
          : 'medium';
    }
    if (isDalle) {
      // Ask for bytes so the client never has to fetch an expiring OpenAI URL.
      body.response_format = 'b64_json';
    }

    let response: Response;
    try {
      response = await fetch(`${config.openaiBaseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.imageTimeoutMs),
      });
    } catch (e) {
      throw new ProviderError(
        `openai images unreachable: ${(e as Error).message}`,
        504,
        true,
      );
    }

    const json = (await response.json().catch(() => ({}))) as ImagesResponse;

    if (!response.ok) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`openai image error ${response.status}: ${detail}`);
      throw upstreamError('openai', response.status, detail);
    }

    const images: GeneratedImage[] = (json.data || [])
      .map((d): GeneratedImage | null => {
        if (!d.b64_json && !d.url) return null;
        return {
          b64: d.b64_json,
          url: d.url,
          mimeType: 'image/png',
          revisedPrompt: d.revised_prompt,
        };
      })
      .filter((d): d is GeneratedImage => d !== null);

    if (images.length === 0) {
      throw new ProviderError('openai returned no image', 502, true);
    }

    return { images, model };
  },
};
