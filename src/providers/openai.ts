import { config } from '../config';
import { log } from '../log';
import { ProviderError } from './types';
import type { ChatProvider, ChatReply, ChatRequest, ChatStreamChunk } from './types';

interface CompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

interface StreamChunk {
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export const openaiProvider: ChatProvider = {
  name: 'openai',
  model: config.openaiModel,

  async chat(req: ChatRequest): Promise<ChatReply> {
    const body = {
      model: config.openaiModel,
      messages: [
        { role: 'system', content: req.system },
        ...req.turns.map((t) => ({ role: t.role, content: t.content })),
      ],
      max_completion_tokens: req.maxOutputTokens,
      // The app renders a structured card, so the reply must be a JSON object.
      response_format: { type: 'json_object' },
      // Keep the reasoning budget small: the answer is a short card, and every
      // reasoning token counts against max_completion_tokens and the bill.
      reasoning_effort: 'low',
    };

    let response: Response;
    try {
      response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (e) {
      // Timeout or network failure: worth a retry, so say so.
      throw new ProviderError(`openai unreachable: ${(e as Error).message}`, 504, true);
    }

    const json = (await response.json().catch(() => ({}))) as CompletionResponse;

    if (!response.ok) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`openai error ${response.status}: ${detail}`);
      throw new ProviderError(
        detail,
        // 429 and 5xx are transient; anything else means the request or the
        // key is wrong and retrying just burns another call.
        response.status === 429 || response.status >= 500 ? 503 : 502,
        response.status === 429 || response.status >= 500,
      );
    }

    const text = json.choices?.[0]?.message?.content?.trim() || '';
    if (!text) {
      throw new ProviderError('openai returned an empty completion', 502, true);
    }

    return {
      text,
      model: config.openaiModel,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  },

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamChunk, void, void> {
    const body = {
      model: config.openaiModel,
      messages: [
        { role: 'system', content: req.system },
        ...req.turns.map((t) => ({ role: t.role, content: t.content })),
      ],
      max_completion_tokens: req.maxOutputTokens,
      // The streamed content is the JSON card, parsed incrementally by the
      // route so the app can grow the card as tokens arrive.
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
      stream: true,
      // Ask for the usage frame the non-stream call gets for free, so the quota
      // log and the client's done event still carry real token counts.
      stream_options: { include_usage: true },
    };

    let response: Response;
    try {
      response = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (e) {
      throw new ProviderError(`openai unreachable: ${(e as Error).message}`, 504, true);
    }

    if (!response.ok || !response.body) {
      const json = (await response.json().catch(() => ({}))) as CompletionResponse;
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`openai error ${response.status}: ${detail}`);
      throw new ProviderError(
        detail,
        response.status === 429 || response.status >= 500 ? 503 : 502,
        response.status === 429 || response.status >= 500,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let model = config.openaiModel;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawToken = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // The SSE frames are `data: {...}` lines separated by newlines; a frame
      // can straddle two reads, so only consume up to the last newline.
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          continue;
        }

        if (chunk.model) model = chunk.model;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          sawToken = true;
          yield { delta };
        }
      }
    }

    if (!sawToken) {
      throw new ProviderError('openai returned an empty completion', 502, true);
    }

    yield { done: true, model, inputTokens, outputTokens };
  },
};
