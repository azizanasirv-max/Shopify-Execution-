/**
 * Gemini LLM provider (Google Generative Language REST API).
 *
 * Retained as a selectable provider so existing behaviour is not removed; Groq
 * is the default (see provider-registry). Authentication uses the supported
 * `x-goog-api-key` header - the key is never placed in the URL query string.
 */

import {
  LlmGenerateRequest,
  LlmGenerateResult,
  LlmMessage,
  LlmProvider,
  LlmStreamDelta,
  LlmToolCall,
  TokenUsage
} from "./types.js";

export interface GeminiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GeminiProvider implements LlmProvider {
  public readonly id = "gemini";
  public readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) {
      throw new Error("GeminiProvider requires an API key.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.defaultModel = options.defaultModel || "gemini-3.1-flash-lite";
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  public async generate(req: LlmGenerateRequest): Promise<LlmGenerateResult> {
    const model = req.model || this.defaultModel;
    const url = `${this.baseUrl}/models/${model}:generateContent`;
    const response = await this.post(url, this.buildBody(req), req.abortSignal);
    const data = await response.json() as any;
    return this.parseCandidate(data);
  }

  public async generateStream(
    req: LlmGenerateRequest,
    onDelta: (delta: LlmStreamDelta) => void
  ): Promise<LlmGenerateResult> {
    const model = req.model || this.defaultModel;
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    const response = await this.post(url, this.buildBody(req), req.abortSignal);

    if (!response.body) {
      const fallback = await this.generate({ ...req });
      if (fallback.text) onDelta({ textDelta: fallback.text });
      return fallback;
    }

    const reader = (response.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let toolCalls: LlmToolCall[] | undefined;
    let usage: TokenUsage | undefined;

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
          if (!payload || payload === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const parsed = this.parseCandidate(chunk);
          if (parsed.text) {
            text += parsed.text;
            onDelta({ textDelta: parsed.text });
          }
          if (parsed.toolCalls) toolCalls = parsed.toolCalls;
          if (parsed.usage) usage = parsed.usage;
        }
      }
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }

    return { text, toolCalls, usage };
  }

  private buildBody(req: LlmGenerateRequest): Record<string, any> {
    const contents: any[] = [];
    for (const msg of req.messages || []) {
      contents.push(this.toGeminiContent(msg));
    }
    const body: Record<string, any> = { contents };
    if (req.systemInstruction) {
      body.systemInstruction = { parts: [{ text: req.systemInstruction }] };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = [{
        functionDeclarations: req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }))
      }];
    }
    if (req.maxOutputTokens !== undefined || req.temperature !== undefined) {
      body.generationConfig = {};
      if (req.maxOutputTokens !== undefined) body.generationConfig.maxOutputTokens = req.maxOutputTokens;
      if (req.temperature !== undefined) body.generationConfig.temperature = req.temperature;
    }
    return body;
  }

  private toGeminiContent(msg: LlmMessage): any {
    if (msg.role === "tool") {
      return {
        role: "user",
        parts: [{ functionResponse: { name: msg.name || msg.toolCallId || "tool", response: { result: msg.content } } }]
      };
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: any[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const call of msg.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.args || {} } });
      }
      return { role: "model", parts };
    }
    return { role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] };
  }

  private parseCandidate(data: any): LlmGenerateResult {
    const candidate = data?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    let text = "";
    const toolCalls: LlmToolCall[] = [];
    for (const part of parts) {
      if (typeof part.text === "string") text += part.text;
      if (part.functionCall) {
        toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
      }
    }
    return {
      text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: this.parseUsage(data?.usageMetadata),
      finishReason: candidate?.finishReason
    };
  }

  private parseUsage(raw: any): TokenUsage | undefined {
    if (!raw) return undefined;
    const inputTokens = raw.promptTokenCount ?? 0;
    const outputTokens = raw.candidatesTokenCount ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: raw.totalTokenCount ?? inputTokens + outputTokens,
      estimated: false
    };
  }

  private async post(url: string, body: Record<string, any>, abortSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener("abort", onExternalAbort);
    }

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
          "User-Agent": "lbv-sales-engine/1.0"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 429) {
          throw new Error(`Gemini API Quota Exceeded (429): ${errorText}`);
        }
        throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
      }
      return response;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(`Gemini API request timed out after ${this.timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
