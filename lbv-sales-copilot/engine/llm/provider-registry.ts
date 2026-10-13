/**
 * Provider selection. Groq is the initial/default provider; Gemini remains
 * available so no existing capability is removed. Selection is driven purely by
 * configuration (environment bindings), never hard-coded credentials.
 */

import { LlmProvider } from "./types.js";
import { GroqProvider } from "./groq-provider.js";
import { GeminiProvider } from "./gemini-provider.js";

export type LlmProviderId = "groq" | "gemini";

export const DEFAULT_PROVIDER_ID: LlmProviderId = "groq";

export interface ProviderEnv {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS?: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

export interface CreateProviderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Resolves the configured provider id, defaulting to Groq. */
export function resolveProviderId(env: ProviderEnv): LlmProviderId {
  const raw = (env.LLM_PROVIDER || "").trim().toLowerCase();
  if (raw === "gemini") return "gemini";
  if (raw === "groq") return "groq";
  return DEFAULT_PROVIDER_ID;
}

function resolveTimeoutMs(env: ProviderEnv, override?: number): number {
  if (override && override > 0) return override;
  const parsed = env.LLM_TIMEOUT_MS ? parseInt(env.LLM_TIMEOUT_MS, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20000;
}

/**
 * Creates the configured provider. Returns `null` when the selected provider has
 * no API key configured, so callers can fail closed with a clear error instead
 * of silently falling back to another provider.
 */
export function createLlmProvider(env: ProviderEnv, options: CreateProviderOptions = {}): LlmProvider | null {
  const providerId = resolveProviderId(env);
  const timeoutMs = resolveTimeoutMs(env, options.timeoutMs);
  const model = env.LLM_MODEL;

  if (providerId === "gemini") {
    if (!env.GEMINI_API_KEY) return null;
    return new GeminiProvider({
      apiKey: env.GEMINI_API_KEY,
      defaultModel: model || undefined,
      timeoutMs,
      fetchImpl: options.fetchImpl
    });
  }

  if (!env.GROQ_API_KEY) return null;
  return new GroqProvider({
    apiKey: env.GROQ_API_KEY,
    defaultModel: model || undefined,
    timeoutMs,
    fetchImpl: options.fetchImpl
  });
}
