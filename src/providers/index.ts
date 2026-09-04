import { config } from '../config';
import { geminiProvider } from './gemini';
import { openaiProvider } from './openai';
import type { ChatProvider } from './types';

/**
 * The upstream this instance bills, chosen once at boot by `AI_PROVIDER`.
 *
 * Both implementations satisfy the same [ChatProvider] contract, so switching
 * providers is an env change and a redeploy — the route and the app see no
 * difference.
 */
export const provider: ChatProvider =
  config.provider === 'gemini' ? geminiProvider : openaiProvider;

export * from './types';
