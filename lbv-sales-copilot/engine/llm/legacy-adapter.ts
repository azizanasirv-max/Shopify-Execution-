/**
 * Backward-compatibility bridge between the provider-agnostic `LlmProvider`
 * interface and the engine's historical Gemini-shaped `ModelProvider` contract.
 *
 * This keeps `GenericSalesEngine`, every existing validation suite, and all
 * provider mocks working unchanged while the underlying transport is fully
 * provider-agnostic. It is the ONLY place that knows about the legacy shape.
 */

import { ModelProvider } from "../types.js";
import { LlmMessage, LlmProvider, LlmStreamDelta, LlmToolCall, LlmToolDefinition, TokenUsage } from "./types.js";

export interface LegacyGenerateParams {
  model: string;
  contents: any[];
  config?: any;
}

export class LegacyModelProviderAdapter implements ModelProvider {
  constructor(private readonly provider: LlmProvider) {}

  public get providerId(): string {
    return this.provider.id;
  }

  public get defaultModel(): string {
    return this.provider.defaultModel;
  }

  /** True when the underlying provider supports incremental generation. */
  public supportsStreaming(): boolean {
    return typeof this.provider.generateStream === "function";
  }

  public async generateContent(params: LegacyGenerateParams): Promise<{ text?: string; functionCalls?: any[]; candidates?: any[]; usage?: TokenUsage }> {
    const result = await this.provider.generate(this.toNormalizedRequest(params));
    return {
      text: result.text,
      functionCalls: this.toLegacyFunctionCalls(result.toolCalls),
      usage: result.usage
    };
  }

  /**
   * Streaming variant of the legacy contract. Deltas are surfaced through
   * `onTextDelta`, and the fully assembled (Gemini-shaped) result is returned so
   * the caller can validate the complete text before exposing anything.
   */
  public async generateContentStream(
    params: LegacyGenerateParams,
    onTextDelta: (delta: string) => void
  ): Promise<{ text?: string; functionCalls?: any[]; candidates?: any[]; usage?: TokenUsage }> {
    if (typeof this.provider.generateStream !== "function") {
      const result = await this.generateContent(params);
      if (result.text) onTextDelta(result.text);
      return result;
    }
    const result = await this.provider.generateStream(this.toNormalizedRequest(params), (delta: LlmStreamDelta) => {
      if (delta.textDelta) onTextDelta(delta.textDelta);
    });
    return {
      text: result.text,
      functionCalls: this.toLegacyFunctionCalls(result.toolCalls),
      usage: result.usage
    };
  }

  private toNormalizedRequest(params: LegacyGenerateParams) {
    return {
      model: params.model,
      systemInstruction: params.config?.systemInstruction,
      messages: this.contentsToMessages(params.contents || []),
      tools: this.configToTools(params.config)
    };
  }

  private contentsToMessages(contents: any[]): LlmMessage[] {
    const messages: LlmMessage[] = [];
    for (const content of contents) {
      const parts = content?.parts || [];
      const textParts = parts.filter((p: any) => typeof p.text === "string").map((p: any) => p.text).join("");
      const callParts = parts.filter((p: any) => p.functionCall);
      const responseParts = parts.filter((p: any) => p.functionResponse);

      if (responseParts.length > 0) {
        for (const p of responseParts) {
          messages.push({
            role: "tool",
            name: p.functionResponse?.name,
            content: JSON.stringify(p.functionResponse?.response?.result ?? p.functionResponse?.response ?? null)
          });
        }
        continue;
      }

      if (callParts.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts,
          toolCalls: callParts.map((p: any): LlmToolCall => ({
            name: p.functionCall?.name || "unknown",
            args: p.functionCall?.args || {}
          }))
        });
        continue;
      }

      if (textParts.length > 0) {
        messages.push({
          role: content.role === "model" ? "assistant" : "user",
          content: textParts
        });
      }
    }
    return messages;
  }

  private configToTools(config: any): LlmToolDefinition[] | undefined {
    const declarations = config?.tools?.[0]?.functionDeclarations;
    if (!Array.isArray(declarations) || declarations.length === 0) return undefined;
    return declarations.map((d: any) => ({
      name: d.name,
      description: d.description || "",
      parameters: d.parameters || { type: "object", properties: {}, required: [] }
    }));
  }

  private toLegacyFunctionCalls(toolCalls?: LlmToolCall[]): any[] | undefined {
    if (!toolCalls || toolCalls.length === 0) return undefined;
    return toolCalls.map((call) => ({ name: call.name, args: call.args || {} }));
  }
}
