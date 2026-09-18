import { config } from '../config';
import { log } from '../log';
import { ProviderError, upstreamError } from './types';
import type {
  VideoHandle,
  VideoProgress,
  VideoProvider,
  VideoRequest,
} from './types';

interface VideoJobResponse {
  id?: string;
  status?: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
  error?: { message?: string } | null;
}

/** Sora renders at these frames only; anything else is a 400. */
const SORA_SIZES = new Set(['720x1280', '1280x720', '1024x1792', '1792x1024']);
/** And these lengths only, as strings. */
const SORA_SECONDS = new Set([4, 8, 12]);

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${config.openaiApiKey}` };
}

/**
 * OpenAI Sora. A job API rather than a long-running operation: POST /videos
 * queues a render, GET /videos/{id} reports status, and the bytes come from
 * GET /videos/{id}/content — which needs the key, so the app fetches the clip
 * through this gateway rather than from OpenAI.
 */
export const openaiVideoProvider: VideoProvider = {
  name: 'openai',
  model: config.openaiVideoModel,

  async start(req: VideoRequest): Promise<VideoHandle> {
    const model = config.openaiVideoModel;
    const size = req.size && SORA_SIZES.has(req.size) ? req.size : '720x1280';
    const seconds = req.seconds && SORA_SECONDS.has(req.seconds) ? req.seconds : 4;

    let response: Response;
    try {
      response = await fetch(`${config.openaiBaseUrl}/videos`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: req.prompt,
          size,
          // The API takes the duration as a string, not a number.
          seconds: String(seconds),
        }),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`sora unreachable: ${(e as Error).message}`, 504, true);
    }

    const json = (await response.json().catch(() => ({}))) as VideoJobResponse & {
      error?: { message?: string };
    };
    if (!response.ok || !json.id) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`sora start error ${response.status}: ${detail}`);
      throw upstreamError('sora', response.status, detail);
    }

    return { upstreamId: json.id, model };
  },

  async poll(handle: VideoHandle): Promise<VideoProgress> {
    let response: Response;
    try {
      response = await fetch(`${config.openaiBaseUrl}/videos/${handle.upstreamId}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`sora unreachable: ${(e as Error).message}`, 504, true);
    }

    const json = (await response.json().catch(() => ({}))) as VideoJobResponse & {
      error?: { message?: string };
    };
    if (!response.ok) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`sora poll error ${response.status}: ${detail}`);
      throw upstreamError('sora', response.status, detail);
    }

    if (json.status === 'failed') {
      return { status: 'failed', error: json.error?.message || 'sora render failed' };
    }
    if (json.status !== 'completed') return { status: 'pending' };

    // Sora hosts the bytes behind the same key, so the "url" here is the
    // content endpoint and only [download] may call it.
    return {
      status: 'ready',
      url: `${config.openaiBaseUrl}/videos/${handle.upstreamId}/content`,
    };
  },

  async download(_handle: VideoHandle, url: string): Promise<Response> {
    try {
      return await fetch(url, { headers: authHeaders() });
    } catch (e) {
      throw new ProviderError(`sora download failed: ${(e as Error).message}`, 504, true);
    }
  },
};
