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
  RealtimeTranscriptEvent,
  RecommendationApprovalStatus,
  SAFE_FALLBACK_RECOMMENDATION,
  ModelProvider,
  ConversationTurn,
  SalesSession
} from "./types.js";
import { validateToolCall } from "./schema-validator.js";
import { AdapterRegistry } from "./adapter-registry.js";

export type { ConversationTurn } from "./types.js";

export interface SalesEngineConfig {
  aiClient?: GoogleGenAI;
  modelProvider?: ModelProvider;
  modelName?: string;
  defaultAdapter?: SalesApiAdapter;
  adapterRegistry?: AdapterRegistry;
  logger?: (level: "info" | "warn" | "error", message: string, meta?: any) => void;
}

export interface GenerateRecommendationOptions {
  adapter?: SalesApiAdapter;
  productId?: string;
  session?: SalesSession;
  history?: ConversationTurn[];
}

export class GenericSalesEngine {
  private modelProvider: ModelProvider;
  private modelName: string;
  private defaultAdapter?: SalesApiAdapter;
  private adapterRegistry?: AdapterRegistry;
  private conversationHistory: ConversationTurn[] = [];
  private logger: (level: "info" | "warn" | "error", message: string, meta?: any) => void;
  private recentTranscripts = new Map<string, number>();
  private readonly maxHistoryTurns: number = 100;

  private pushBoundedHistory(historyArray: ConversationTurn[] | undefined, userTurn: ConversationTurn, modelTurn: ConversationTurn): void {
    if (!historyArray) return;
    historyArray.push(userTurn, modelTurn);
    if (historyArray.length > this.maxHistoryTurns) {
      historyArray.splice(0, historyArray.length - this.maxHistoryTurns);
    }
  }

  constructor(config: SalesEngineConfig) {
    if (config.modelProvider) {
      this.modelProvider = config.modelProvider;
    } else if (config.aiClient) {
      const ai = config.aiClient;
      this.modelProvider = {
        generateContent: (params) => ai.models.generateContent(params)
      };
    } else {
      throw new Error("SalesEngineConfig must provide either aiClient or modelProvider.");
    }
    this.modelName = config.modelName || "gemini-3.1-flash-lite";
    this.defaultAdapter = config.defaultAdapter;
    this.adapterRegistry = config.adapterRegistry;
    this.logger = config.logger || ((level, msg, meta) => {
      if (level === "error") {
        console.error(`[SalesEngine:${level.toUpperCase()}] ${msg}`, meta || "");
      } else {
        console.log(`[SalesEngine:${level.toUpperCase()}] ${msg}`, meta || "");
      }
    });
  }

  /**
   * Set or switch default fallback adapter (legacy / single-user support)
   */
  public setAdapter(adapter: SalesApiAdapter): void {
    this.logger("info", `Setting default Sales API adapter to: ${adapter.name} (${adapter.id})`);
    this.defaultAdapter = adapter;
    this.clearConversation();
  }

  /**
   * Returns current active fallback adapter details
   */
  public getActiveAdapter(): SalesApiAdapter {
    if (!this.defaultAdapter) {
      throw new Error("No default adapter configured on GenericSalesEngine. Use request-scoped adapter resolution.");
    }
    return this.defaultAdapter;
  }

  /**
   * Clears in-memory default conversation state
   */
  public clearConversation(): void {
    this.conversationHistory = [];
  }

  /**
   * Returns conversation turns history for default single-user state
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
   * @param adapterOrOptions Explicit SalesApiAdapter OR GenerateRecommendationOptions for request/session scoping
   */
  public async generateRecommendation(
    prospectPrompt: string,
    adapterOrOptions?: SalesApiAdapter | GenerateRecommendationOptions
  ): Promise<SalesRecommendation> {
    const startTime = Date.now();
    let activeAdapter: SalesApiAdapter | undefined;
    let session: SalesSession | undefined;
    let isolatedHistory: ConversationTurn[] | undefined;

    if (adapterOrOptions) {
      if ("getTools" in adapterOrOptions && typeof (adapterOrOptions as any).getTools === "function") {
        activeAdapter = adapterOrOptions as SalesApiAdapter;
      } else {
        const opts = adapterOrOptions as GenerateRecommendationOptions;
        session = opts.session;
        isolatedHistory = opts.history;
        if (opts.adapter) {
          activeAdapter = opts.adapter;
        } else if (opts.productId && this.adapterRegistry) {
          activeAdapter = this.adapterRegistry.resolve(opts.productId);
        } else if (opts.session && this.adapterRegistry) {
          activeAdapter = this.adapterRegistry.resolve(opts.session.productId);
        }
      }
    }

    if (!activeAdapter) {
      activeAdapter = this.defaultAdapter;
    }

    if (!activeAdapter) {
      throw new Error("GenericSalesEngine: No SalesApiAdapter resolved for recommendation generation. Specify adapter or configure defaultAdapter.");
    }

    const toolsLogged: ToolCallResult[] = [];
    const modelStart = Date.now();
    let modelExecutionMs = 0;
    let approvalGateStart = 0;
    let approvalGateMs = 0;

    this.logger("info", `Processing recommendation for adapter: ${activeAdapter.id}${session ? ` [Session: ${session.id}]` : ""}`, {
      prompt: prospectPrompt,
      sessionId: session?.id
    });

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
      let response = await this.modelProvider.generateContent({
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
        response = await this.modelProvider.generateContent({
          model: this.modelName,
          contents: currentContents,
          config: {
            systemInstruction: activeAdapter.getSystemInstructions(),
            tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
          }
        });
      }

      modelExecutionMs = Date.now() - modelStart;
      approvalGateStart = Date.now();

      const rawStatement = response.text || "";
      let validationReport = activeAdapter.validateResponse(rawStatement, prospectPrompt);
      let status: RecommendationApprovalStatus = "APPROVED";
      let finalStatement = rawStatement;
      let recoveryAttempts = 0;
      let rawUnapprovedStatement: string | undefined = undefined;

      // Validation Gate - Check if initial response passed
      if (!validationReport.isGrounded || validationReport.unsupportedClaims.length > 0) {
        status = "RECOVERY_REQUIRED";
        rawUnapprovedStatement = rawStatement;
        this.logger("warn", `Validation failed on initial generation: [${validationReport.unsupportedClaims.join("; ")}]. Initiating bounded recovery.`);

        // Bounded Recovery: Retry at most once with validation findings as feedback
        recoveryAttempts++;
        turnsCount++;

        const correctivePrompt = `The previous proposed recommendation failed compliance validation due to the following policy violations:\n${validationReport.unsupportedClaims.map(c => `- ${c}`).join("\n")}\n\nPlease regenerate a strictly compliant recommendation for the salesperson. Stick strictly to verified tool data, do not offer unauthorized prices or discounts, do not make financial guarantees, and adhere strictly to the behavioral policies. Produce only the next statement for the salesperson.`;

        const recoveryContents = [
          ...currentContents,
          { role: "model", parts: [{ text: rawStatement }] },
          { role: "user", parts: [{ text: correctivePrompt }] }
        ];

        try {
          const recoveryResponse = await this.modelProvider.generateContent({
            model: this.modelName,
            contents: recoveryContents,
            config: {
              systemInstruction: activeAdapter.getSystemInstructions()
            }
          });

          const recoveredStatement = recoveryResponse.text || "";
          const recoveryValidation = activeAdapter.validateResponse(recoveredStatement, prospectPrompt);

          if (recoveryValidation.isGrounded && recoveryValidation.unsupportedClaims.length === 0) {
            status = "APPROVED";
            finalStatement = recoveredStatement;
            validationReport = recoveryValidation;
            this.logger("info", "Bounded recovery succeeded and passed validation.");
          } else {
            status = "BLOCKED";
            validationReport = recoveryValidation;
            rawUnapprovedStatement = recoveredStatement;
            finalStatement = SAFE_FALLBACK_RECOMMENDATION;
            this.logger("warn", `Bounded recovery failed validation: [${recoveryValidation.unsupportedClaims.join("; ")}]. Enforcing BLOCKED approval gate.`);
          }
        } catch (recoveryErr: any) {
          this.logger("error", "Error during bounded recovery attempt:", recoveryErr);
          status = "BLOCKED";
          finalStatement = SAFE_FALLBACK_RECOMMENDATION;
        }
      }

      // Ensure that BLOCKED results NEVER expose the unapproved/rejected text as the statement
      if (status === "BLOCKED") {
        finalStatement = SAFE_FALLBACK_RECOMMENDATION;
      }

      approvalGateMs = Date.now() - approvalGateStart;
      const totalLatency = Date.now() - startTime;

      // Record in conversation state (isolated per session/request)
      const userTurn: ConversationTurn = {
        role: "user",
        text: prospectPrompt,
        timestamp: startTime
      };

      const modelTurn: ConversationTurn = {
        role: "model",
        text: finalStatement,
        toolCalls: toolsLogged,
        timestamp: Date.now()
      };

      if (session) {
        this.pushBoundedHistory(session.conversationHistory, userTurn, modelTurn);
        session.lastActivityAt = Date.now();
      } else if (isolatedHistory) {
        this.pushBoundedHistory(isolatedHistory, userTurn, modelTurn);
      } else {
        this.pushBoundedHistory(this.conversationHistory, userTurn, modelTurn);
      }

      const recommendation: SalesRecommendation = {
        statement: finalStatement,
        status,
        toolsUsed: toolsLogged,
        validationReport,
        timestamp: Date.now(),
        engineMetadata: {
          model: this.modelName,
          productId: activeAdapter.id,
          latencyMs: totalLatency,
          modelExecutionMs,
          approvalGateMs,
          turnsCount,
          recoveryAttempts,
          isFallback: status === "BLOCKED",
          rawUnapprovedStatement,
          sessionId: session?.id
        } as any
      };

      this.logger("info", `Recommendation completed with status [${status}] (${totalLatency}ms)`, {
        status,
        toolsUsedCount: toolsLogged.length,
        isGrounded: validationReport.isGrounded,
        recoveryAttempts
      });

      return recommendation;

    } catch (error: any) {
      this.logger("error", `Engine failed to generate recommendation: ${error.message || error}`, error);
      
      const totalLatency = Date.now() - startTime;
      const failedRecommendation: SalesRecommendation = {
        statement: SAFE_FALLBACK_RECOMMENDATION,
        status: "BLOCKED",
        toolsUsed: toolsLogged,
        validationReport: {
          isGrounded: false,
          unsupportedClaims: [`Model provider error: ${error.message || "Failed to generate recommendation"}`],
          rulesPassed: [{
            name: "Execution Guard",
            status: "FAILED",
            description: "Model generation failed or encountered an error."
          }]
        },
        timestamp: Date.now(),
        engineMetadata: {
          model: this.modelName,
          productId: activeAdapter ? activeAdapter.id : "unknown",
          latencyMs: totalLatency,
          turnsCount,
          recoveryAttempts: 0,
          isFallback: true,
          sessionId: session?.id
        }
      };

      return failedRecommendation;
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
      const trimmedText = event.text.trim();
      const now = Date.now();

      // Clean up old entries (> 5 seconds old)
      for (const [txt, time] of this.recentTranscripts.entries()) {
        if (now - time > 5000) {
          this.recentTranscripts.delete(txt);
        }
      }

      if (this.recentTranscripts.has(trimmedText)) {
        this.logger("info", `Suppressing duplicate final transcript event: "${trimmedText}"`);
        return;
      }

      this.recentTranscripts.set(trimmedText, now);
      this.logger("info", `Realtime prospect statement received: "${trimmedText}"`);
      const rec = await this.generateRecommendation(trimmedText);
      onRecommendationReady(rec);
    }
  }
}
