import { config } from '../config';
import { geminiProvider } from './gemini';
import { geminiImageProvider } from './geminiImage';
import { geminiVideoProvider } from './geminiVideo';
import { googleTranslateProvider } from './googleTranslate';
import { grokImageProvider } from './grokImage';
import { createModelTranslateProvider } from './modelTranslate';
import { createOpenAiCompatibleProvider } from './openaiCompatible';
import { openaiImageProvider } from './openaiImage';
import { openaiVideoProvider } from './openaiVideo';
import type { ChatProvider, ImageProvider, TranslateProvider, VideoProvider } from './types';

/**
 * Every upstream this gateway knows how to talk to, keyed by the value you put
 * in `AI_PROVIDER`. Adding another OpenAI-compatible vendor is one entry here.
 */
const CHAT_PROVIDERS: Record<string, () => ChatProvider> = {
  openai: () =>
    createOpenAiCompatibleProvider({
      name: 'openai',
      apiKey: config.openaiApiKey,
      baseUrl: config.openaiBaseUrl,
      model: config.openaiModel,
      tokenParam: 'max_completion_tokens',
      supportsReasoningEffort: true,
    }),

  deepseek: () =>
    createOpenAiCompatibleProvider({
      name: 'deepseek',
      apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
      // DeepSeek kept OpenAI's older parameter name and has no reasoning knob:
      // you pick the budget by choosing deepseek-chat or deepseek-reasoner.
      tokenParam: 'max_tokens',
    }),

  grok: () =>
    createOpenAiCompatibleProvider({
      name: 'grok',
      apiKey: config.grokApiKey,
      baseUrl: config.grokBaseUrl,
      model: config.grokModel,
      tokenParam: 'max_tokens',
    }),

  // Anything else that speaks OpenAI's /chat/completions, addressed by URL
  // rather than by name: OpenRouter, GitHub Models, Groq, Together, a local
  // Ollama or LM Studio. The free tiers live here.
  compat: () =>
    createOpenAiCompatibleProvider({
      name: 'compat',
      apiKey: config.compatApiKey,
      baseUrl: config.compatBaseUrl,
      model: config.compatModel,
      tokenParam: config.compatTokenParam,
    }),

  gemini: () => geminiProvider,
};

/**
 * The upstream this instance bills for chat, chosen once at boot by
 * `AI_PROVIDER`.
 *
 * Every implementation satisfies the same [ChatProvider] contract, so switching
 * providers is an env change and a redeploy — the route and the app see no
 * difference.
 */
export const provider: ChatProvider = (
  CHAT_PROVIDERS[config.provider] ?? CHAT_PROVIDERS.openai
)();

/** Image upstream, or null when `IMAGE_PROVIDER=off` — the route then 404s. */
export const imageProvider: ImageProvider | null =
  config.imageProvider === 'openai'
    ? openaiImageProvider
    : config.imageProvider === 'gemini'
      ? geminiImageProvider
      : config.imageProvider === 'grok'
        ? grokImageProvider
        : null;

/** Video upstream, or null when `VIDEO_PROVIDER=off`. */
export const videoProvider: VideoProvider | null =
  config.videoProvider === 'gemini'
    ? geminiVideoProvider
    : config.videoProvider === 'openai'
      ? openaiVideoProvider
      : null;

/**
 * Translation upstream, or null when `TRANSLATE_PROVIDER=off`.
 *
 * `model` reuses the chat provider above, so it follows `AI_PROVIDER` for free;
 * `google` is the dedicated per-character API and is billed separately.
 */
export const translateProvider: TranslateProvider | null =
  config.translateProvider === 'google'
    ? googleTranslateProvider
    : config.translateProvider === 'model'
      ? createModelTranslateProvider(provider)
      : null;

export * from './types';
