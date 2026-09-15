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
  /**
   * Ask the upstream to constrain its output to a JSON object. Every caller in
   * this gateway wants that (the chat card and the translation envelope are
   * both JSON), so it defaults to on; a provider whose model cannot do it
   * simply ignores the flag and leans on the prompt instead.
   */
  json?: boolean;
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

// ── Image ───────────────────────────────────────────────────────────────────

export interface ImageRequest {
  prompt: string;
  /** How many images to draw. Clamped by MAX_IMAGES_PER_REQUEST before we get here. */
  count: number;
  /** `WIDTHxHEIGHT`, or 'auto'. Providers that have no size knob ignore it. */
  size: string;
  /** 'standard' | 'hd'. Ignored where the model has no quality tier. */
  quality?: string;
}

export interface GeneratedImage {
  /** Base64 payload, set when the upstream returns bytes rather than a link. */
  b64?: string;
  /** Direct link, set when the upstream hosts the result itself. */
  url?: string;
  mimeType: string;
  /** What the model actually drew, when it rewrites the prompt (DALL·E, Grok). */
  revisedPrompt?: string;
}

export interface ImageReply {
  images: GeneratedImage[];
  model: string;
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(req: ImageRequest): Promise<ImageReply>;
}

// ── Video ───────────────────────────────────────────────────────────────────

export interface VideoRequest {
  prompt: string;
  /** `WIDTHxHEIGHT` for Sora, mapped to an aspect ratio for Veo. */
  size?: string;
  /** Clip length in seconds. Each model accepts only a few values. */
  seconds?: number;
}

/** What the upstream calls the render it started. Opaque to the client. */
export interface VideoHandle {
  /** Provider-side job id or long-running operation name. */
  upstreamId: string;
  model: string;
}

export type VideoStatus = 'pending' | 'ready' | 'failed';

export interface VideoProgress {
  status: VideoStatus;
  /** Playable link, present once status is 'ready'. */
  url?: string;
  /** Why it failed, present once status is 'failed'. Logged, not shown raw. */
  error?: string;
}

/**
 * Video renders take minutes, so the contract is start-then-poll rather than
 * one long request: [start] hands back a handle, [poll] reports on it.
 */
export interface VideoProvider {
  readonly name: string;
  readonly model: string;
  start(req: VideoRequest): Promise<VideoHandle>;
  poll(handle: VideoHandle): Promise<VideoProgress>;
  /**
   * Streams the finished render through the gateway. Present only where the
   * upstream link needs the API key, which must never reach the client.
   */
  download?(handle: VideoHandle, url: string): Promise<Response>;
}

// ── Translation ─────────────────────────────────────────────────────────────

export interface TranslateRequest {
  texts: string[];
  /** BCP-47-ish target, e.g. `vi`, `pt-BR`. */
  to: string;
  /** Source language, or 'auto' to let the upstream detect it. */
  from?: string;
}

export interface TranslateReply {
  /** Same length and order as the request's texts. */
  translations: string[];
  /** Detected source language when the upstream reports one. */
  detected?: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TranslateProvider {
  readonly name: string;
  readonly model: string;
  translate(req: TranslateRequest): Promise<TranslateReply>;
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

/**
 * Maps an upstream HTTP status onto the status this gateway returns and
 * whether a retry is worth the caller's while: 429 and 5xx are transient,
 * anything else means the request or the key is wrong and retrying just burns
 * another call.
 */
export function upstreamError(name: string, status: number, detail: string): ProviderError {
  const transient = status === 429 || status >= 500;
  return new ProviderError(`${name}: ${detail}`, transient ? 503 : 502, transient);
}
