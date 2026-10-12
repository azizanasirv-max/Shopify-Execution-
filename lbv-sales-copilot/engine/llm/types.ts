/**
 * Provider-agnostic LLM abstraction for the LBV Sales Engine.
 *
 * The engine and all adapters speak ONLY this normalized interface. Provider
 * specific request/response formats (Groq / OpenAI-compatible chat completions,
 * Gemini REST, ...) are isolated behind `LlmProvider` implementations so that
 * switching providers never touches engine, adapter, or session logic.
 *
 * Security note: secrets are never part of a request object; they are held by
 * the provider instance (constructed from environment bindings).
 */

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  /** Provider-supplied call id (used to correlate tool responses). */
  id?: string;
  name: string;
  args: Record<string, any>;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Assistant messages may carry tool calls. */
  toolCalls?: LlmToolCall[];
  /** Tool result messages correlate to a call via this id. */
  toolCallId?: string;
  /** Optional tool name for tool-result messages. */
  name?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** True when tokens were estimated locally rather than reported by the provider. */
  estimated?: boolean;
}

export interface LlmGenerateRequest {
  model?: string;
  systemInstruction?: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Cooperative cancellation (timeouts, stale-response aborts). */
  abortSignal?: AbortSignal;
}

export interface LlmGenerateResult {
  text: string;
  toolCalls?: LlmToolCall[];
  usage?: TokenUsage;
  finishReason?: string;
}

export interface LlmStreamDelta {
  /** Incremental text produced by the model. */
  textDelta?: string;
}

export interface LlmProvider {
  /** Stable provider identifier, e.g. "groq" or "gemini". */
  readonly id: string;
  /** Default model used when a request omits `model`. */
  readonly defaultModel: string;
  /** Non-streaming generation. */
  generate(req: LlmGenerateRequest): Promise<LlmGenerateResult>;
  /**
   * Optional incremental generation. Implementations MUST still return the
   * complete assembled result so callers can run validation on the whole text.
   */
  generateStream?(
    req: LlmGenerateRequest,
    onDelta: (delta: LlmStreamDelta) => void
  ): Promise<LlmGenerateResult>;
}
