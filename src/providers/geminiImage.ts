import { config } from '../config';
import { log } from '../log';
import { ProviderError, upstreamError } from './types';
import type { GeneratedImage, ImageProvider, ImageReply, ImageRequest } from './types';

interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    finishReason?: string;
  }[];
  error?: { message?: string };
}

interface PredictResponse {
  predictions?: { bytesBase64Encoded?: string; mimeType?: string }[];
  error?: { message?: string };
}

/** Imagen takes an aspect ratio, not pixels, and only these five. */
export function toAspectRatio(size: string): string {
  const [w, h] = size.split('x').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) return '1:1';
  const ratio = w / h;
  const options: [string, number][] = [
    ['1:1', 1],
    ['3:4', 0.75],
    ['4:3', 4 / 3],
    ['9:16', 0.5625],
    ['16:9', 16 / 9],
  ];
  return options.reduce((best, o) =>
    Math.abs(o[1] - ratio) < Math.abs(best[1] - ratio) ? o : best,
  )[0];
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  try {
    return await fetch(`${config.geminiBaseUrl}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.imageTimeoutMs),
    });
  } catch (e) {
    throw new ProviderError(`gemini images unreachable: ${(e as Error).message}`, 504, true);
  }
}

/**
 * Google images. Two model families on two different endpoints:
 *
 * - `gemini-*-image` ("nano banana") is a chat model that happens to emit
 *   pixels — `:generateContent` with `responseModalities: ["IMAGE"]`, one
 *   image per call, and it understands conversational prompts.
 * - `imagen-*` is the dedicated text-to-image model — `:predict`, up to four
 *   samples per call, sized by aspect ratio rather than pixels.
 *
 * Which one runs is decided by GEMINI_IMAGE_MODEL alone.
 */
export const geminiImageProvider: ImageProvider = {
  name: 'gemini',
  model: config.geminiImageModel,

  async generate(req: ImageRequest): Promise<ImageReply> {
    const model = config.geminiImageModel;
    const images: GeneratedImage[] = [];

    if (model.startsWith('imagen')) {
      const response = await post(`models/${encodeURIComponent(model)}:predict`, {
        instances: [{ prompt: req.prompt }],
        parameters: {
          sampleCount: Math.min(Math.max(req.count, 1), 4),
          aspectRatio: toAspectRatio(req.size),
        },
      });
      const json = (await response.json().catch(() => ({}))) as PredictResponse;
      if (!response.ok) {
        const detail = json.error?.message || `http ${response.status}`;
        log.warn(`gemini image error ${response.status}: ${detail}`);
        throw upstreamError('gemini', response.status, detail);
      }
      for (const p of json.predictions || []) {
        if (p.bytesBase64Encoded) {
          images.push({ b64: p.bytesBase64Encoded, mimeType: p.mimeType || 'image/png' });
        }
      }
    } else {
      const response = await post(`models/${encodeURIComponent(model)}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        // Without this the model answers in words and draws nothing.
        generationConfig: { responseModalities: ['IMAGE'] },
      });
      const json = (await response.json().catch(() => ({}))) as GenerateContentResponse;
      if (!response.ok) {
        const detail = json.error?.message || `http ${response.status}`;
        log.warn(`gemini image error ${response.status}: ${detail}`);
        throw upstreamError('gemini', response.status, detail);
      }
      const candidate = json.candidates?.[0];
      for (const part of candidate?.content?.parts || []) {
        const inline = part.inlineData;
        if (inline?.data) {
          images.push({ b64: inline.data, mimeType: inline.mimeType || 'image/png' });
        }
      }
      if (images.length === 0) {
        // A safety-blocked request comes back 200 with no inline part, so the
        // finish reason is the only clue worth logging.
        throw new ProviderError(
          `gemini returned no image (finishReason=${candidate?.finishReason ?? 'none'})`,
          502,
          true,
        );
      }
    }

    if (images.length === 0) {
      throw new ProviderError('gemini returned no image', 502, true);
    }

    return { images, model };
  },
};
