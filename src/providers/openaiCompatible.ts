import { config } from '../config';
import { log } from '../log';
import { ProviderError, upstreamError } from './types';
import type { ChatProvider, ChatReply, ChatRequest, ChatStreamChunk } from './types';

/**
 * OpenAI, DeepSeek and xAI all speak the same `POST /chat/completions` shape:
 * a Bearer key, a `messages` array, SSE frames of `choices[0].delta.content`.
 * Only three details differ, and each is a flag below — so adding the next
 * OpenAI-compatible vendor is one entry in `providers/index.ts`, not a file.
 */
export interface CompatOptions {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** OpenAI renamed the cap to `max_completion_tokens`; the others kept `max_tokens`. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Only OpenAI's o-series / gpt-5 take a reasoning budget. */
  supportsReasoningEffort?: boolean;
}

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

/**
 * Reasoning models take a thinking budget instead of a temperature and reject
 * an explicit one: OpenAI's o1/o3/o4 and gpt-5, DeepSeek's `deepseek-reasoner`,
 * xAI's `grok-*-mini` line. Sending temperature to those is a 400.
 */
function isReasoning(o: CompatOptions): boolean {
  if (o.name === 'openai') return /^(o[134]|gpt-5)/.test(o.model);
  if (o.name === 'deepseek') return o.model.includes('reasoner');
  if (o.name === 'grok') return /mini/.test(o.model);
  return false;
}

/** `deepseek-reasoner` is the one model here that cannot be held to JSON mode. */
function supportsJsonMode(o: CompatOptions): boolean {
  return !(o.name === 'deepseek' && o.model.includes('reasoner'));
}

function buildBody(
  o: CompatOptions,
  req: ChatRequest,
  stream: boolean,
): Record<string, unknown> {
  const reasoning = isReasoning(o);

  const body: Record<string, unknown> = {
    model: o.model,
    messages: [
      { role: 'system', content: req.system },
      ...req.turns.map((t) => ({ role: t.role, content: t.content })),
    ],
    [o.tokenParam]: req.maxOutputTokens,
  };

  // The app renders a structured card, so the reply must be a JSON object.
  if (req.json !== false && supportsJsonMode(o)) {
    body.response_format = { type: 'json_object' };
  }
  if (reasoning && o.supportsReasoningEffort) {
    // Keep the reasoning budget small: the answer is a short card, and every
    // reasoning token counts against the output cap and the bill.
    body.reasoning_effort = 'low';
  }
  if (!reasoning) {
    body.temperature = 0.6;
  }
  if (stream) {
    body.stream = true;
    // Ask for the usage frame the non-stream call gets for free, so the quota
    // log and the client's done event still carry real token counts.
    body.stream_options = { include_usage: true };
  }

  return body;
}

async function post(
  o: CompatOptions,
  body: Record<string, unknown>,
): Promise<Response> {
  try {
    return await fetch(`${o.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${o.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (e) {
    // Timeout or network failure: worth a retry, so say so.
    throw new ProviderError(`${o.name} unreachable: ${(e as Error).message}`, 504, true);
  }
}

/**
 * Walks an SSE body and yields each parsed `data:` payload.
 *
 * Shared by both paths because some OpenAI-compatible proxies — 9Router among
 * them — answer in SSE whether or not `stream` was asked for, so the
 * non-streaming call has to be able to read frames too.
 */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // A frame can straddle two reads, so only consume up to the last newline.
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;

      try {
        yield JSON.parse(payload) as StreamChunk;
      } catch {
        continue;
      }
    }
  }
}

/** True when the upstream streamed at us regardless of what we asked for. */
function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') || '').includes('text/event-stream');
}

export function createOpenAiCompatibleProvider(o: CompatOptions): ChatProvider {
  return {
    name: o.name,
    model: o.model,

    async chat(req: ChatRequest): Promise<ChatReply> {
      const response = await post(o, buildBody(o, req, false));

      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as CompletionResponse;
        const detail = json.error?.message || `http ${response.status}`;
        log.warn(`${o.name} error ${response.status}: ${detail}`);
        throw upstreamError(o.name, response.status, detail);
      }

      let text = '';
      let model = o.model;
      let inputTokens = 0;
      let outputTokens = 0;

      if (isEventStream(response) && response.body) {
        // The proxy streamed anyway; fold the deltas back into one reply so the
        // caller never learns the difference.
        for await (const chunk of sseFrames(response.body)) {
          if (chunk.model) model = chunk.model;
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          }
          // `reasoning_content` deltas are the model thinking out loud; only
          // `content` is the answer.
          text += chunk.choices?.[0]?.delta?.content ?? '';
        }
      } else {
        const json = (await response.json().catch(() => ({}))) as CompletionResponse;
        text = json.choices?.[0]?.message?.content ?? '';
        inputTokens = json.usage?.prompt_tokens ?? 0;
        outputTokens = json.usage?.completion_tokens ?? 0;
      }

      text = text.trim();
      if (!text) {
        throw new ProviderError(`${o.name} returned an empty completion`, 502, true);
      }

      return { text, model, inputTokens, outputTokens };
    },

    async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamChunk, void, void> {
      const response = await post(o, buildBody(o, req, true));

      if (!response.ok || !response.body) {
        const json = (await response.json().catch(() => ({}))) as CompletionResponse;
        const detail = json.error?.message || `http ${response.status}`;
        log.warn(`${o.name} error ${response.status}: ${detail}`);
        throw upstreamError(o.name, response.status, detail);
      }

      let model = o.model;
      let inputTokens = 0;
      let outputTokens = 0;
      let sawToken = false;

      for await (const chunk of sseFrames(response.body)) {
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

      if (!sawToken) {
        throw new ProviderError(`${o.name} returned an empty completion`, 502, true);
      }

      yield { done: true, model, inputTokens, outputTokens };
    },
  };
}
