/**
 * Generic Sales Engine
 *
 * A reusable, product-independent conversation orchestration engine.
 * Decoupled from any specific product or business vertical.
 *
 * Key Responsibilities:
 * 1. Conversation Orchestration & State Management
 * 2. Model / Provider Integration (Gemini SDK with function calling loop)
 * 3. Restricted Tool Execution (strictly bounded by active SalesApiAdapter)
 * 4. Salesperson Recommendation Synthesis ("SAY THIS NEXT")
 * 5. Error Handling, Observability, and Telemetry
 * 6. Realtime Integration Hooks
 */

import { GoogleGenAI, Type } from "@google/genai";
import {
  SalesApiAdapter,
  SalesRecommendation,
  ToolCallResult,
  ToolDefinition,
  RealtimeTranscriptEvent
} from "./types.js";
import { validateToolCall } from "./schema-validator.js";

export interface SalesEngineConfig {
  aiClient: GoogleGenAI;
  modelName?: string;
  defaultAdapter: SalesApiAdapter;
  logger?: (level: "info" | "warn" | "error", message: string, meta?: any) => void;
}

export interface ConversationTurn {
  role: "user" | "model";
  text?: string;
  toolCalls?: ToolCallResult[];
  timestamp: number;
}

export class GenericSalesEngine {
  private ai: GoogleGenAI;
  private modelName: string;
  private adapter: SalesApiAdapter;
  private conversationHistory: ConversationTurn[] = [];
  private logger: (level: "info" | "warn" | "error", message: string, meta?: any) => void;

  constructor(config: SalesEngineConfig) {
    this.ai = config.aiClient;
    this.modelName = config.modelName || "gemini-3.1-flash-lite";
    this.adapter = config.defaultAdapter;
    this.logger = config.logger || ((level, msg, meta) => {
      if (level === "error") {
        console.error(`[SalesEngine:${level.toUpperCase()}] ${msg}`, meta || "");
      } else {
        console.log(`[SalesEngine:${level.toUpperCase()}] ${msg}`, meta || "");
      }
    });
  }

  /**
   * Set or switch the active product adapter (e.g. from Shopify to Ghostwriter)
   */
  public setAdapter(adapter: SalesApiAdapter): void {
    this.logger("info", `Switching active Sales API adapter to: ${adapter.name} (${adapter.id})`);
    this.adapter = adapter;
    this.clearConversation();
  }

  /**
   * Returns current active adapter details
   */
  public getActiveAdapter(): SalesApiAdapter {
    return this.adapter;
  }

  /**
   * Clears in-memory conversation state
   */
  public clearConversation(): void {
    this.conversationHistory = [];
  }

  /**
   * Returns conversation turns history
   */
  public getHistory(): ConversationTurn[] {
    return [...this.conversationHistory];
  }

  /**
   * Helper to format generic ToolDefinitions into Gemini SDK function declarations
   */
  private buildGeminiFunctionDeclarations(tools: ToolDefinition[]): any[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: tool.parameters?.properties || {},
        required: tool.parameters?.required || []
      }
    }));
  }

  /**
   * Generates a grounded, policy-checked recommendation for the salesperson.
   *
   * @param prospectPrompt The statement, question, or objection from the prospect
   * @param overrideAdapter Optional per-request adapter override
   */
  public async generateRecommendation(
    prospectPrompt: string,
    overrideAdapter?: SalesApiAdapter
  ): Promise<SalesRecommendation> {
    const startTime = Date.now();
    const activeAdapter = overrideAdapter || this.adapter;
    const toolsLogged: ToolCallResult[] = [];

    this.logger("info", `Processing recommendation for adapter: ${activeAdapter.id}`, { prompt: prospectPrompt });

    // Build model tool declarations from the active adapter
    const toolDefinitions = activeAdapter.getTools();
    const functionDeclarations = this.buildGeminiFunctionDeclarations(toolDefinitions);

    // Initial conversation contents
    const currentContents: any[] = [
      { role: "user", parts: [{ text: prospectPrompt }] }
    ];

    let turnsCount = 1;

    try {
      // 1st Model Turn: Determine need for business tools
      let response = await this.ai.models.generateContent({
        model: this.modelName,
        contents: currentContents,
        config: {
          systemInstruction: activeAdapter.getSystemInstructions(),
          tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
        }
      });

      const functionCalls = response.functionCalls;

      // Execute restricted tool calls if requested by the model
      if (functionCalls && functionCalls.length > 0) {
        turnsCount++;
        currentContents.push(response.candidates?.[0]?.content);
        const functionResponseParts: any[] = [];

        for (const call of functionCalls) {
          const toolStart = Date.now();
          const toolName = call.name || "unknown";
          let result: any = null;

          // Find declared tool definition in the active adapter
          const toolDef = toolDefinitions.find((t) => t.name === toolName);

          // Runtime Schema & Argument Validation (Fail-Closed)
          const validation = validateToolCall(toolDef, call.args);

          if (!validation.valid) {
            this.logger("warn", `Runtime tool validation failed for [${toolName}]: ${validation.error}`, {
              args: call.args
            });
            result = { error: validation.error || "Tool validation error" };
          } else {
            try {
              // Restricted tool execution: handled exclusively by the business adapter
              result = await activeAdapter.executeTool(toolName, call.args as Record<string, any>);
            } catch (toolError: any) {
              this.logger("error", `Restricted tool execution failed for [${toolName}]`, toolError);
              result = { error: toolError.message || "Tool execution failed" };
            }
          }

          const latencyMs = Date.now() - toolStart;
          toolsLogged.push({
            tool: toolName,
            args: call.args as Record<string, any>,
            result,
            latencyMs
          });

          functionResponseParts.push({
            functionResponse: {
              name: toolName,
              response: { result }
            }
          });
        }

        currentContents.push({
          role: "user",
          parts: functionResponseParts
        });

        // 2nd Model Turn: Synthesize grounded response using tool results
        response = await this.ai.models.generateContent({
          model: this.modelName,
          contents: currentContents,
          config: {
            systemInstruction: activeAdapter.getSystemInstructions(),
            tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
          }
        });
      }

      const rawStatement = response.text || "";
      const totalLatency = Date.now() - startTime;

      // Validate the recommendation using the active product adapter's compliance validator
      const validationReport = activeAdapter.validateResponse(rawStatement, prospectPrompt);

      // Record in conversation state
      this.conversationHistory.push({
        role: "user",
        text: prospectPrompt,
        timestamp: startTime
      });

      this.conversationHistory.push({
        role: "model",
        text: rawStatement,
        toolCalls: toolsLogged,
        timestamp: Date.now()
      });

      const recommendation: SalesRecommendation = {
        statement: rawStatement,
        toolsUsed: toolsLogged,
        validationReport,
        timestamp: Date.now(),
        engineMetadata: {
          model: this.modelName,
          productId: activeAdapter.id,
          latencyMs: totalLatency,
          turnsCount
        }
      };

      this.logger("info", `Recommendation generated successfully (${totalLatency}ms)`, {
        toolsUsedCount: toolsLogged.length,
        isGrounded: validationReport.isGrounded
      });

      return recommendation;

    } catch (error: any) {
      this.logger("error", `Engine failed to generate recommendation: ${error.message || error}`, error);
      throw error;
    }
  }

  /**
   * Realtime transcript hook:
   * Called when a new spoken turn or transcript segment arrives from a live room.
   */
  public async handleRealtimeTranscript(
    event: RealtimeTranscriptEvent,
    onRecommendationReady: (rec: SalesRecommendation) => void
  ): Promise<void> {
    if (event.speaker === "prospect" && event.isFinal && event.text.trim().length > 0) {
      this.logger("info", `Realtime prospect statement received: "${event.text}"`);
      const rec = await this.generateRecommendation(event.text);
      onRecommendationReady(rec);
    }
  }
}
