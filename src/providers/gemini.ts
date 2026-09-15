import { config } from '../config';
import { log } from '../log';
import { ProviderError, upstreamError } from './types';
import type { ChatProvider, ChatReply, ChatRequest, ChatStreamChunk } from './types';

interface GenerateResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

function buildBody(req: ChatRequest): Record<string, unknown> {
  return {
    // Gemini keeps the system prompt out of the turn list entirely, which is
    // what makes it un-overridable by anything the client sent.
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.turns.map((t) => ({
      // Gemini calls the assistant "model"; everything else maps 1:1.
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    })),
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens,
      temperature: 0.6,
      // Gemini's equivalent of OpenAI's json_object mode: the decoder itself is
      // constrained, so a stray "```json" fence can't reach the card parser.
      ...(req.json === false ? {} : { responseMimeType: 'application/json' }),
    },
  };
}

async function post(method: string, body: Record<string, unknown>): Promise<Response> {
  const url =
    `${config.geminiBaseUrl}/models/${encodeURIComponent(config.geminiModel)}:${method}`;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header rather than a query param, so the key never lands in logs
        // or proxy access records.
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.upstreamTimeoutMs),
    });
  } catch (e) {
    throw new ProviderError(`gemini unreachable: ${(e as Error).message}`, 504, true);
  }
}

export const geminiProvider: ChatProvider = {
  name: 'gemini',
  model: config.geminiModel,

  async chat(req: ChatRequest): Promise<ChatReply> {
    const response = await post('generateContent', buildBody(req));
    const json = (await response.json().catch(() => ({}))) as GenerateResponse;

    if (!response.ok) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`gemini error ${response.status}: ${detail}`);
      throw upstreamError('gemini', response.status, detail);
    }

    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();

    if (!text) {
      // A blocked or truncated candidate comes back 200 with no text, so the
      // finish reason is the only clue worth logging.
      throw new ProviderError(
        `gemini returned no text (finishReason=${candidate?.finishReason ?? 'none'})`,
        502,
        true,
      );
    }

    return {
      text,
      model: config.geminiModel,
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    };
  },

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamChunk, void, void> {
    // `?alt=sse` is what turns the streaming endpoint from a JSON array (which
    // only completes at the end, i.e. not a stream at all) into SSE frames.
    const response = await post('streamGenerateContent?alt=sse', buildBody(req));

    if (!response.ok || !response.body) {
      const json = (await response.json().catch(() => ({}))) as GenerateResponse;
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`gemini error ${response.status}: ${detail}`);
      throw upstreamError('gemini', response.status, detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let sawToken = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '') continue;

        let chunk: GenerateResponse;
        try {
          chunk = JSON.parse(payload) as GenerateResponse;
        } catch {
          continue;
        }

        // Gemini resends cumulative usage on every frame, so the last one wins.
        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
        const delta = (chunk.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || '')
          .join('');
        if (delta.length > 0) {
          sawToken = true;
          yield { delta };
        }
      }
    }

    if (!sawToken) {
      throw new ProviderError('gemini returned no text', 502, true);
    }

    yield { done: true, model: config.geminiModel, inputTokens, outputTokens };
  },
};
