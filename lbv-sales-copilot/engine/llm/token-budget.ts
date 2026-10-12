/**
 * Deterministic token-budget enforcement and usage tracking.
 *
 * Token counting is intentionally provider-independent and deterministic: when a
 * provider reports real `usage` we record it verbatim; otherwise we fall back to
 * a stable local estimate (~4 characters per token) so that budgets behave
 * predictably in tests and offline environments.
 */

import { LlmGenerateRequest, LlmMessage, TokenUsage } from "./types.js";
export type { TokenUsage } from "./types.js";

export const CHARS_PER_TOKEN = 4;

/** Deterministic local token estimate for arbitrary text. */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Deterministic local token estimate for a full generation request. */
export function estimateRequestTokens(req: LlmGenerateRequest): number {
  let total = estimateTokens(req.systemInstruction);
  for (const msg of req.messages || []) {
    total += estimateMessageTokens(msg);
  }
  for (const tool of req.tools || []) {
    total += estimateTokens(tool.name) + estimateTokens(tool.description);
    total += estimateTokens(JSON.stringify(tool.parameters || {}));
  }
  return total;
}

function estimateMessageTokens(msg: LlmMessage): number {
  let total = estimateTokens(msg.content) + 4; // per-message overhead
  for (const call of msg.toolCalls || []) {
    total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.args || {}));
  }
  return total;
}

export class TokenBudgetExceededError extends Error {
  public readonly code = "TOKEN_BUDGET_EXCEEDED";
  constructor(public readonly requested: number, public readonly remaining: number) {
    super(
      `Token budget exceeded: request would consume ~${requested} tokens but only ${remaining} remain.`
    );
    this.name = "TokenBudgetExceededError";
  }
}

export interface TokenBudgetConfig {
  /** Maximum cumulative tokens (input + output) allowed for the scope. 0 or undefined disables enforcement. */
  maxTotalTokens?: number;
  /** Maximum estimated input tokens for any single request. 0 or undefined disables the per-request cap. */
  maxRequestTokens?: number;
}

/**
 * Tracks usage and enforces a cumulative token budget for a single scope
 * (e.g. one session or one request). Safe to share across concurrent turns
 * because all accounting is synchronous.
 */
export class TokenBudget {
  private readonly maxTotalTokens: number;
  private readonly maxRequestTokens: number;
  private inputTokens = 0;
  private outputTokens = 0;
  private requests = 0;

  constructor(config: TokenBudgetConfig = {}) {
    this.maxTotalTokens = config.maxTotalTokens && config.maxTotalTokens > 0 ? config.maxTotalTokens : 0;
    this.maxRequestTokens = config.maxRequestTokens && config.maxRequestTokens > 0 ? config.maxRequestTokens : 0;
  }

  public get usage(): TokenUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens
    };
  }

  public get requestCount(): number {
    return this.requests;
  }

  public get remaining(): number {
    if (this.maxTotalTokens === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.maxTotalTokens - (this.inputTokens + this.outputTokens));
  }

  /** Throws TokenBudgetExceededError when a request would breach the budget. */
  public assertWithinBudget(estimatedInputTokens: number): void {
    if (this.maxRequestTokens > 0 && estimatedInputTokens > this.maxRequestTokens) {
      throw new TokenBudgetExceededError(estimatedInputTokens, this.maxRequestTokens);
    }
    if (this.maxTotalTokens > 0 && estimatedInputTokens > this.remaining) {
      throw new TokenBudgetExceededError(estimatedInputTokens, this.remaining);
    }
  }

  /** Records actual (or estimated) usage for one completed request. */
  public record(usage: TokenUsage): void {
    this.requests += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  public reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.requests = 0;
  }
}

/**
 * Aggregates usage across multiple providers/scopes for observability.
 */
export class UsageTracker {
  private byProvider = new Map<string, TokenUsage & { requests: number }>();

  public record(providerId: string, usage: TokenUsage): void {
    const current = this.byProvider.get(providerId) || {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0
    };
    current.inputTokens += usage.inputTokens;
    current.outputTokens += usage.outputTokens;
    current.totalTokens += usage.totalTokens;
    current.requests += 1;
    this.byProvider.set(providerId, current);
  }

  public snapshot(): Record<string, { inputTokens: number; outputTokens: number; totalTokens: number; requests: number }> {
    const out: Record<string, any> = {};
    for (const [provider, usage] of this.byProvider.entries()) {
      out[provider] = { ...usage };
    }
    return out;
  }
}
