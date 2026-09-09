import { config } from '../config';
import { log } from '../log';
import { ProviderError } from './types';
import type { ChatProvider, ChatReply, ChatRequest } from './types';

interface CompletionResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

export const openaiProvider: ChatProvider = {
  name: 'openai',
  model: config.openaiModel,

  async chat(req: ChatRequest): Promise<ChatReply> {
    // Reasoning models (o1/o3/o4, gpt-5*) only accept the default temperature
    // (1) and reject an explicit value, unlike gpt-4o-class models.
    const isReasoningModel = /^(o[134]|gpt-5)/.test(config.openaiModel);

    const body = {
      model: config.openaiModel,
      messages: [
        { role: 'system', content: req.system },
        ...req.turns.map((t) => ({ role: t.role, content: t.content })),
      ],
      max_completion_tokens: req.maxOutputTokens,
      ...(isReasoningModel ? {} : { temperature: 0.6 }),
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
};
