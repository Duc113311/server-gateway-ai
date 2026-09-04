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

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatReply>;
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
