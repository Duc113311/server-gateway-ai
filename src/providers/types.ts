export type Role = 'user' | 'assistant';

export interface ChatTurn {
  role: Role;
  content: string;
}

export interface ChatRequest {
  /** Server-owned instructions. Never taken from the client. */
  system: string;
  turns: ChatTurn[];
  maxOutputTokens: number;
}

export interface ChatReply {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One item from a streaming completion: either a token [delta] as it arrives,
 * or a final [done] frame carrying the model and token usage.
 */
export interface ChatStreamChunk {
  delta?: string;
  done?: boolean;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatReply>;
  /** Token-by-token variant. Optional — providers without it fall back to [chat]. */
  chatStream?(req: ChatRequest): AsyncGenerator<ChatStreamChunk, void, void>;
}

/**
 * An upstream call that failed in a way worth reporting distinctly — a bad key,
 * a provider-side rate limit, a timeout — so the route can map it to a status
 * instead of turning everything into a 500.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
