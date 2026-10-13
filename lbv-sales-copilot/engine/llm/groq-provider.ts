/**
 * Groq LLM provider (OpenAI-compatible Chat Completions API).
 *
 * This is the initial/default provider for the LBV Sales Engine. It is isolated
 * behind the normalized `LlmProvider` interface so that the engine never depends
 * on Groq-specific request or response shapes.
 *
 * Secrets: the API key is supplied at construction time from environment
 * bindings and is sent only via the `Authorization` header. It is never logged.
 */

import {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmMessage,
  LlmProvider,
  LlmStreamDelta,
  LlmToolCall,
  LlmToolDefinition,
  TokenUsage
} from "./types.js";

export interface GroqProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  /** Optional injected fetch (enables deterministic testing). */
  fetchImpl?: typeof fetch;
}

export class GroqApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GroqApiError";
  }
}

export class GroqProvider implements LlmProvider {
  public readonly id = "groq";
  public readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GroqProviderOptions) {
    if (!options.apiKey) {
      throw new Error("GroqProvider requires an API key.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || "https://api.groq.com/openai/v1").replace(/\/$/, "");
    this.defaultModel = options.defaultModel || "llama-3.1-8b-instant";
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  public async generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const body = this.buildBody(req, false);
    const response = await this.post("/chat/completions", body, req.abortSignal);
    const data = await response.json() as any;
    const message = data?.choices?.[0]?.message || {};
    return {
      text: typeof message.content === "string" ? message.content : "",
      toolCalls: this.parseToolCalls(message.tool_calls),
      usage: this.parseUsage(data?.usage),
      finishReason: data?.choices?.[0]?.finish_reason
    };
  }

  public async generateStream(
    req: LlmGenerateRequest,
    onDelta: (delta: LlmStreamDelta) => void
  ): Promise<LlmGenerateResult> {
    const body = this.buildBody(req, true);
    const response = await this.post("/chat/completions", body, req.abortSignal);

    if (!response.body) {
      // Environment cannot stream; degrade to a single non-streaming generation.
      const fallback = await this.generate({ ...req });
      if (fallback.text) onDelta({ textDelta: fallback.text });
      return fallback;
    }

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCallAccumulator = new Map<number, { id?: string; name?: string; args: string }>();
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = chunk?.choices?.[0];
          const delta = choice?.delta || {};
          if (typeof delta.content === "string" && delta.content.length > 0) {
            text += delta.content;
            onDelta({ textDelta: delta.content });
          }
          for (const tc of delta.tool_calls || []) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const entry = toolCallAccumulator.get(idx) || { args: "" };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
            toolCallAccumulator.set(idx, entry);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk?.usage) usage = this.parseUsage(chunk.usage);
        }
      }
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }

    return {
      text,
      toolCalls: this.accumulatedToolCalls(toolCallAccumulator),
      usage,
      finishReason
    };
  }

  private buildBody(req: LlmGenerateRequest, stream: boolean): Record<string, any> {
    const messages: any[] = [];
    if (req.systemInstruction) {
      messages.push({ role: "system", content: req.systemInstruction });
    }
    for (const msg of req.messages || []) {
      messages.push(this.toOpenAiMessage(msg));
    }

    const body: Record<string, any> = {
      model: req.model || this.defaultModel,
      messages
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((tool: LlmToolDefinition) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }));
      body.tool_choice = "auto";
    }
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private toOpenAiMessage(msg: LlmMessage): any {
    if (msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: msg.toolCallId || msg.name || "call",
        content: msg.content
      };
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((call) => ({
          id: call.id || call.name,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) }
        }))
      };
    }
    return { role: msg.role, content: msg.content };
  }

  private parseToolCalls(raw: any): LlmToolCall[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw.map((call: any) => ({
      id: call.id,
      name: call.function?.name || "unknown",
      args: this.safeParseArgs(call.function?.arguments)
    }));
  }

  private accumulatedToolCalls(acc: Map<number, { id?: string; name?: string; args: string }>): LlmToolCall[] | undefined {
    if (acc.size === 0) return undefined;
    const calls: LlmToolCall[] = [];
    for (const entry of acc.values()) {
      if (!entry.name) continue;
      calls.push({ id: entry.id, name: entry.name, args: this.safeParseArgs(entry.args) });
    }
    return calls.length > 0 ? calls : undefined;
  }

  private safeParseArgs(raw: any): Record<string, any> {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private parseUsage(raw: any): TokenUsage | undefined {
    if (!raw) return undefined;
    const inputTokens = raw.prompt_tokens ?? 0;
    const outputTokens = raw.completion_tokens ?? 0;
    const totalTokens = raw.total_tokens ?? inputTokens + outputTokens;
    return { inputTokens, outputTokens, totalTokens, estimated: false };
  }

  private async post(path: string, body: Record<string, any>, abortSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener("abort", onExternalAbort);
    }

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "lbv-sales-engine/1.0"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 429) {
          throw new GroqApiError(429, `Groq rate limit exceeded (429): ${errorText}`);
        }
        throw new GroqApiError(response.status, `Groq API error (${response.status}): ${errorText}`);
      }
      return response;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(`Groq request aborted or timed out after ${this.timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
