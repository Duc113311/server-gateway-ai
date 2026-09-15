import 'dotenv/config';

export type ProviderName = 'openai' | 'gemini';
export type AuthMode = 'firebase' | 'none';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  port: num('PORT', 8080),

  /** Which upstream to bill. Everything else about the API stays the same. */
  provider: (process.env.AI_PROVIDER || 'openai').toLowerCase() as ProviderName,

  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',

  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
  geminiBaseUrl:
    process.env.GEMINI_BASE_URL ||
    'https://generativelanguage.googleapis.com/v1beta',

  /**
   * 'firebase' verifies a Firebase ID token on every call; 'none' skips auth
   * and is for local development only — an open gateway spends your tokens for
   * anyone who finds the URL.
   */
  authMode: (process.env.AUTH_MODE || 'firebase').toLowerCase() as AuthMode,
  serviceAccountPath:
    process.env.SERVICE_ACCOUNT_PATH || './serviceAccount.json',

  /** Cost guards. Every one of these caps what a single caller can spend. */
  maxPromptChars: num('MAX_PROMPT_CHARS', 1000),
  maxHistoryTurns: num('MAX_HISTORY_TURNS', 12),
  maxOutputTokens: num('MAX_OUTPUT_TOKENS', 500),
  requestsPerMinute: num('RATE_PER_MINUTE', 8),
  requestsPerDay: num('RATE_PER_DAY', 5),
  upstreamTimeoutMs: num('UPSTREAM_TIMEOUT_MS', 30_000),

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

/**
 * Fails fast at boot instead of on the first user request — a gateway that
 * starts without its key looks healthy right up until someone chats.
 */
export function assertConfig(): void {
  const problems: string[] = [];

  if (config.provider !== 'openai' && config.provider !== 'gemini') {
    problems.push(`AI_PROVIDER must be "openai" or "gemini", got "${config.provider}"`);
  }
  if (config.provider === 'openai' && !config.openaiApiKey) {
    problems.push('OPENAI_API_KEY is empty but AI_PROVIDER=openai');
  }
  if (config.provider === 'gemini' && !config.geminiApiKey) {
    problems.push('GEMINI_API_KEY is empty but AI_PROVIDER=gemini');
  }
  if (config.authMode !== 'firebase' && config.authMode !== 'none') {
    problems.push(`AUTH_MODE must be "firebase" or "none", got "${config.authMode}"`);
  }

  if (problems.length > 0) {
    throw new Error(`Bad configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
