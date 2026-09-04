import { config } from '../config';
import { log } from '../log';
import { ProviderError } from './types';
import type { ChatProvider, ChatReply, ChatRequest } from './types';

interface GenerateResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

export const geminiProvider: ChatProvider = {
  name: 'gemini',
  model: config.geminiModel,

  async chat(req: ChatRequest): Promise<ChatReply> {
    const body = {
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
      },
    };

    const url =
      `${config.geminiBaseUrl}/models/${encodeURIComponent(config.geminiModel)}` +
      `:generateContent`;

    let response: Response;
    try {
      response = await fetch(url, {
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

    const json = (await response.json().catch(() => ({}))) as GenerateResponse;

    if (!response.ok) {
      const detail = json.error?.message || `http ${response.status}`;
      log.warn(`gemini error ${response.status}: ${detail}`);
      const transient = response.status === 429 || response.status >= 500;
      throw new ProviderError(detail, transient ? 503 : 502, transient);
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
};
