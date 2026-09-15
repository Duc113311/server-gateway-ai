import { config } from '../config';
import { log } from '../log';
import { toAspectRatio } from './geminiImage';
import { ProviderError, upstreamError } from './types';
import type {
  VideoHandle,
  VideoProgress,
  VideoProvider,
  VideoRequest,
} from './types';

interface OperationResponse {
  name?: string;
  done?: boolean;
  error?: { message?: string; code?: number };
  response?: {
    generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] };
    generatedVideos?: { video?: { uri?: string } }[];
  };
}

function headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': config.geminiApiKey,
  };
}

/**
 * Google Veo. A render takes one to several minutes, so the API is a
 * long-running operation: `:predictLongRunning` hands back an operation name
 * and you GET that name until `done` flips.
 *
 * The finished clip lives behind a Files API URI that only accepts the API key,
 * so it can never be handed to the app directly — [download] is what keeps the
 * key on this side of the wire.
 */
export const geminiVideoProvider: VideoProvider = {
  name: 'gemini',
  model: config.geminiVideoModel,

  async start(req: VideoRequest): Promise<VideoHandle> {
    const model = config.geminiVideoModel;
    const parameters: Record<string, unknown> = {
      aspectRatio: toAspectRatio(req.size || '1280x720'),
    };
    // Veo 3 renders a fixed 8s and rejects durationSeconds; Veo 2 takes 5-8.
    if (req.seconds && model.startsWith('veo-2')) {
      parameters.durationSeconds = Math.min(Math.max(req.seconds, 5), 8);
    }

    let response: Response;
    try {
      response = await fetch(
        `${config.geminiBaseUrl}/models/${encodeURIComponent(model)}:predictLongRunning`,
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            instances: [{ prompt: req.prompt }],
            parameters,
          }),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        },
      );
    } catch (e) {
      throw new ProviderError(`veo unreachable: ${(e as Error).message}`, 504, true);
    }

    const json = (await response.json().catch(() => ({}))) as OperationResponse;
    if (!response.ok || !json.name) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`veo start error ${response.status}: ${detail}`);
      throw upstreamError('veo', response.status, detail);
    }

    return { upstreamId: json.name, model };
  },

  async poll(handle: VideoHandle): Promise<VideoProgress> {
    let response: Response;
    try {
      // The operation name already carries its own `models/...` prefix, so it
      // is appended to the base URL whole.
      response = await fetch(`${config.geminiBaseUrl}/${handle.upstreamId}`, {
        headers: headers(),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`veo unreachable: ${(e as Error).message}`, 504, true);
    }

    const json = (await response.json().catch(() => ({}))) as OperationResponse;
    if (!response.ok) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`veo poll error ${response.status}: ${detail}`);
      throw upstreamError('veo', response.status, detail);
    }

    if (!json.done) return { status: 'pending' };
    if (json.error) {
      return { status: 'failed', error: json.error.message || 'veo render failed' };
    }

    // The sample list moved between API revisions; read whichever is present.
    const uri =
      json.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ??
      json.response?.generatedVideos?.[0]?.video?.uri;

    if (!uri) return { status: 'failed', error: 'veo finished with no video uri' };
    return { status: 'ready', url: uri };
  },

  async download(_handle: VideoHandle, url: string): Promise<Response> {
    try {
      // `alt=media` asks the Files API for the bytes rather than the metadata.
      const sep = url.includes('?') ? '&' : '?';
      return await fetch(`${url}${sep}alt=media`, { headers: headers() });
    } catch (e) {
      throw new ProviderError(`veo download failed: ${(e as Error).message}`, 504, true);
    }
  },
};
