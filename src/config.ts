import 'dotenv/config';

/**
 * Upstreams that can answer a chat turn. All satisfy one interface.
 *
 * `compat` is the escape hatch: any other service that speaks OpenAI's
 * `/chat/completions` — OpenRouter, GitHub Models, Groq, Together, a local
 * Ollama or LM Studio — configured by URL instead of by name.
 */
export type ChatProviderName = 'openai' | 'gemini' | 'deepseek' | 'grok' | 'compat';
/** Upstreams that can draw. DeepSeek has no image model, so it is absent. */
export type ImageProviderName = 'openai' | 'gemini' | 'grok' | 'off';
/** Upstreams that can render video. Only Veo and Sora exist today. */
export type VideoProviderName = 'gemini' | 'openai' | 'off';
/**
 * 'model' translates through whatever AI_PROVIDER is set to (no extra key,
 * costs chat tokens); 'google' uses the dedicated Cloud Translation v2 API
 * (cheaper per character, no prompt to go wrong, 100+ languages).
 */
export type TranslateProviderName = 'model' | 'google' | 'off';
export type AuthMode = 'firebase' | 'none';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function str(name: string, fallback: string): string {
  return (process.env[name] || fallback).trim();
}

function lower<T extends string>(name: string, fallback: T): T {
  return str(name, fallback).toLowerCase() as T;
}

export const config = {
  port: num('PORT', 8080),

  // ── Which upstream serves which feature ───────────────────────────────────
  /** Chat, and translation too when TRANSLATE_PROVIDER=model. */
  provider: lower<ChatProviderName>('AI_PROVIDER', 'openai'),
  imageProvider: lower<ImageProviderName>('IMAGE_PROVIDER', 'off'),
  videoProvider: lower<VideoProviderName>('VIDEO_PROVIDER', 'off'),
  translateProvider: lower<TranslateProviderName>('TRANSLATE_PROVIDER', 'off'),

  // ── OpenAI ────────────────────────────────────────────────────────────────
  openaiApiKey: str('OPENAI_API_KEY', ''),
  openaiModel: str('OPENAI_MODEL', 'gpt-4o-mini'),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  openaiImageModel: str('OPENAI_IMAGE_MODEL', 'gpt-image-1'),
  openaiVideoModel: str('OPENAI_VIDEO_MODEL', 'sora-2'),

  // ── Google Gemini ─────────────────────────────────────────────────────────
  geminiApiKey: str('GEMINI_API_KEY', ''),
  geminiModel: str('GEMINI_MODEL', 'gemini-2.0-flash'),
  geminiBaseUrl: str(
    'GEMINI_BASE_URL',
    'https://generativelanguage.googleapis.com/v1beta',
  ),
  geminiImageModel: str('GEMINI_IMAGE_MODEL', 'gemini-2.5-flash-image'),
  geminiVideoModel: str('GEMINI_VIDEO_MODEL', 'veo-3.0-fast-generate-001'),

  // ── DeepSeek (OpenAI-compatible wire format) ──────────────────────────────
  deepseekApiKey: str('DEEPSEEK_API_KEY', ''),
  deepseekModel: str('DEEPSEEK_MODEL', 'deepseek-chat'),
  deepseekBaseUrl: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),

  // ── xAI Grok (OpenAI-compatible wire format) ──────────────────────────────
  grokApiKey: str('GROK_API_KEY', ''),
  grokModel: str('GROK_MODEL', 'grok-4-fast'),
  grokBaseUrl: str('GROK_BASE_URL', 'https://api.x.ai/v1'),
  grokImageModel: str('GROK_IMAGE_MODEL', 'grok-2-image-1212'),

  // ── Any other OpenAI-compatible endpoint ──────────────────────────────────
  compatApiKey: str('COMPAT_API_KEY', ''),
  compatModel: str('COMPAT_MODEL', ''),
  /** Must end where `/chat/completions` can be appended, e.g. `.../v1`. */
  compatBaseUrl: str('COMPAT_BASE_URL', ''),
  /**
   * Most OpenAI-compatible services kept the older `max_tokens`; only OpenAI
   * itself renamed it. Flip this if yours rejects the default.
   */
  compatTokenParam:
    lower<string>('COMPAT_TOKEN_PARAM', 'max_tokens') === 'max_completion_tokens'
      ? ('max_completion_tokens' as const)
      : ('max_tokens' as const),

  // ── Google Cloud Translation v2 ───────────────────────────────────────────
  googleTranslateApiKey: str('GOOGLE_TRANSLATE_API_KEY', ''),
  googleTranslateBaseUrl: str(
    'GOOGLE_TRANSLATE_BASE_URL',
    'https://translation.googleapis.com/language/translate/v2',
  ),

  /**
   * 'firebase' verifies a Firebase ID token on every call; 'none' skips auth
   * and is for local development only — an open gateway spends your tokens for
   * anyone who finds the URL.
   */
  authMode: lower<AuthMode>('AUTH_MODE', 'firebase'),
  /**
   * Path to the service account JSON, or empty to use Application Default
   * Credentials — which is what a Cloud Run deployment in the same project
   * wants, so an explicitly empty value is honoured rather than defaulted.
   */
  serviceAccountPath:
    process.env.SERVICE_ACCOUNT_PATH !== undefined
      ? process.env.SERVICE_ACCOUNT_PATH.trim()
      : './serviceAccount.json',

  /** Cost guards. Every one of these caps what a single caller can spend. */
  maxPromptChars: num('MAX_PROMPT_CHARS', 1000),
  maxHistoryTurns: num('MAX_HISTORY_TURNS', 12),
  maxOutputTokens: num('MAX_OUTPUT_TOKENS', 500),
  requestsPerMinute: num('RATE_PER_MINUTE', 8),
  requestsPerDay: num('RATE_PER_DAY', 5),
  upstreamTimeoutMs: num('UPSTREAM_TIMEOUT_MS', 30_000),

  /** Image guards. One image costs many chat turns, so it gets its own bucket. */
  maxImagePromptChars: num('MAX_IMAGE_PROMPT_CHARS', 1000),
  maxImagesPerRequest: num('MAX_IMAGES_PER_REQUEST', 1),
  imageRatePerMinute: num('IMAGE_RATE_PER_MINUTE', 2),
  imageRatePerDay: num('IMAGE_RATE_PER_DAY', 5),
  imageTimeoutMs: num('IMAGE_TIMEOUT_MS', 120_000),

  /** Video guards. Dearest call in the gateway by an order of magnitude. */
  maxVideoPromptChars: num('MAX_VIDEO_PROMPT_CHARS', 1000),
  videoRatePerDay: num('VIDEO_RATE_PER_DAY', 2),
  /** How long a finished job stays readable before it is swept. */
  videoJobTtlMs: num('VIDEO_JOB_TTL_MS', 60 * 60 * 1000),

  /** Translation guards. Billed per character, so the cap is on total size. */
  maxTranslateChars: num('MAX_TRANSLATE_CHARS', 5000),
  maxTranslateItems: num('MAX_TRANSLATE_ITEMS', 50),
  translateRatePerMinute: num('TRANSLATE_RATE_PER_MINUTE', 20),
  translateRatePerDay: num('TRANSLATE_RATE_PER_DAY', 200),

  logLevel: lower('LOG_LEVEL', 'info'),
};

/** The API key each upstream authenticates with, by provider name. */
export function apiKeyFor(name: string): string {
  switch (name) {
    case 'openai':
      return config.openaiApiKey;
    case 'gemini':
      return config.geminiApiKey;
    case 'deepseek':
      return config.deepseekApiKey;
    case 'grok':
      return config.grokApiKey;
    case 'compat':
      return config.compatApiKey;
    default:
      return '';
  }
}

/**
 * Fails fast at boot instead of on the first user request — a gateway that
 * starts without its key looks healthy right up until someone chats.
 */
export function assertConfig(): void {
  const problems: string[] = [];

  const chatNames: string[] = ['openai', 'gemini', 'deepseek', 'grok', 'compat'];
  if (!chatNames.includes(config.provider)) {
    problems.push(
      `AI_PROVIDER must be one of ${chatNames.join(' | ')}, got "${config.provider}"`,
    );
  } else if (config.provider === 'compat') {
    // A keyless endpoint is a real case (a local Ollama), so only the two
    // things that have no sane default are required here.
    if (!config.compatBaseUrl) {
      problems.push('COMPAT_BASE_URL is empty but AI_PROVIDER=compat');
    }
    if (!config.compatModel) {
      problems.push('COMPAT_MODEL is empty but AI_PROVIDER=compat');
    }
  } else if (!apiKeyFor(config.provider)) {
    problems.push(
      `${config.provider.toUpperCase()}_API_KEY is empty but AI_PROVIDER=${config.provider}`,
    );
  }

  // Each optional feature is validated only when it is switched on, so a
  // chat-only deployment never needs an image or a video key.
  const imageNames: string[] = ['openai', 'gemini', 'grok', 'off'];
  if (!imageNames.includes(config.imageProvider)) {
    problems.push(`IMAGE_PROVIDER must be one of ${imageNames.join(' | ')}`);
  } else if (config.imageProvider !== 'off' && !apiKeyFor(config.imageProvider)) {
    problems.push(
      `${config.imageProvider.toUpperCase()}_API_KEY is empty but ` +
        `IMAGE_PROVIDER=${config.imageProvider}`,
    );
  }

  const videoNames: string[] = ['gemini', 'openai', 'off'];
  if (!videoNames.includes(config.videoProvider)) {
    problems.push(`VIDEO_PROVIDER must be one of ${videoNames.join(' | ')}`);
  } else if (config.videoProvider !== 'off' && !apiKeyFor(config.videoProvider)) {
    problems.push(
      `${config.videoProvider.toUpperCase()}_API_KEY is empty but ` +
        `VIDEO_PROVIDER=${config.videoProvider}`,
    );
  }

  const translateNames: string[] = ['model', 'google', 'off'];
  if (!translateNames.includes(config.translateProvider)) {
    problems.push(`TRANSLATE_PROVIDER must be one of ${translateNames.join(' | ')}`);
  } else if (config.translateProvider === 'google' && !config.googleTranslateApiKey) {
    problems.push('GOOGLE_TRANSLATE_API_KEY is empty but TRANSLATE_PROVIDER=google');
  }

  if (config.authMode !== 'firebase' && config.authMode !== 'none') {
    problems.push(`AUTH_MODE must be "firebase" or "none", got "${config.authMode}"`);
  }

  if (problems.length > 0) {
    throw new Error(`Bad configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
