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
import {
  TokenBudget,
  UsageTracker,
  TokenUsage,
  estimateTokens
} from "./llm/token-budget.js";
import { withConciseDirective, decideRouting } from "./llm/routing.js";

export type { ConversationTurn } from "./types.js";

export interface SalesEngineConfig {
  aiClient?: GoogleGenAI;
  modelProvider?: ModelProvider;
  modelName?: string;
  defaultAdapter?: SalesApiAdapter;
  adapterRegistry?: AdapterRegistry;
  logger?: (level: "info" | "warn" | "error", message: string, meta?: any) => void;
  /** Stable id of the active LLM provider (observability only). */
  providerId?: string;
  /** Optional cumulative token budget enforced around every model call. */
  tokenBudget?: TokenBudget;
  /** Optional cross-provider usage aggregator. */
  usageTracker?: UsageTracker;
  /** When true, deterministic routing may skip model calls for non-actionable utterances. */
  deterministicRouting?: boolean;
  /** When enabled, a brevity constraint is appended to the system instruction. */
  conciseOutput?: { enabled: boolean; minWords?: number; maxWords?: number };
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
  /**
   * How many most-recent turns are sent to the model as CONTEXT.
   *
   * Stored session history stays bounded by {@link maxHistoryTurns} (persistence
   * and history views are unaffected); this only caps what is put on the wire for
   * each recommendation. Model time-to-first-token is dominated by input size and
   * the realtime path re-sends the context on EVERY final prospect segment, so an
   * unbounded context directly adds to the visible "say this next" delay.
   */
  private readonly maxContextTurns: number = 20;
  private readonly providerId: string;
  private readonly tokenBudget?: TokenBudget;
  private readonly usageTracker?: UsageTracker;
  private readonly deterministicRouting: boolean;
  private readonly conciseOutput: { enabled: boolean; minWords?: number; maxWords?: number };

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
    this.providerId = config.providerId || "unknown";
    this.tokenBudget = config.tokenBudget;
    this.usageTracker = config.usageTracker;
    this.deterministicRouting = config.deterministicRouting === true;
    this.conciseOutput = config.conciseOutput || { enabled: false };
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
   * Invokes the model through a single choke point that applies the concise
   * output directive, enforces the token budget, optionally streams deltas, and
   * records usage. All model traffic flows through here.
   */
  private async invokeModel(
    contents: any[],
    systemInstruction: string,
    functionDeclarations: any[],
    onTextDelta?: (delta: string) => void
  ): Promise<{ text?: string; functionCalls?: any[]; candidates?: any[]; usage?: TokenUsage }> {
    const effectiveSystemInstruction = this.conciseOutput.enabled
      ? withConciseDirective(systemInstruction, {
          minWords: this.conciseOutput.minWords,
          maxWords: this.conciseOutput.maxWords
        })
      : systemInstruction;

    if (this.tokenBudget) {
      const estimated =
        estimateTokens(effectiveSystemInstruction) + estimateTokens(JSON.stringify(contents));
      this.tokenBudget.assertWithinBudget(estimated);
    }

    const params = {
      model: this.modelName,
      contents,
      config: {
        systemInstruction: effectiveSystemInstruction,
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined
      }
    };

    const streamFn = (this.modelProvider as any).generateContentStream;
    let result: any;
    if (onTextDelta && typeof streamFn === "function") {
      result = await streamFn.call(this.modelProvider, params, onTextDelta);
    } else {
      result = await this.modelProvider.generateContent(params);
    }

    const usage: TokenUsage | undefined = result?.usage;
    if (usage) {
      if (this.tokenBudget) this.tokenBudget.record(usage);
      if (this.usageTracker) this.usageTracker.record(this.providerId, usage);
    }

    return { text: result?.text, functionCalls: result?.functionCalls, candidates: result?.candidates, usage };
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
   * True when the deterministic router would invoke the model for `text`.
   *
   * Exposed so transport-level ingress (the Worker's transcript routes) can skip
   * an entire model pipeline for an utterance that cannot yield an actionable
   * next line - a backchannel or filler such as "mm-hmm" or "ok" - instead of
   * paying for the call and discarding the result. Uses the SAME deterministic
   * router that already guards the realtime path; no approval or validation
   * behaviour changes.
   */
  public shouldInvokeModel(text: string): boolean {
    if (!this.deterministicRouting) return true;
    return decideRouting(text).invokeModel;
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
    let lastUsage: TokenUsage | undefined;
    let approvalGateStart = 0;
    let approvalGateMs = 0;

    this.logger("info", `Processing recommendation for adapter: ${activeAdapter.id}${session ? ` [Session: ${session.id}]` : ""}`, {
      prompt: prospectPrompt,
      sessionId: session?.id
    });

    // Build model tool declarations from the active adapter
    const toolDefinitions = activeAdapter.getTools();
    const functionDeclarations = this.buildGeminiFunctionDeclarations(toolDefinitions);

    // Incorporate prior conversation history context if provided or present in session
    const effectiveHistory = session?.conversationHistory || isolatedHistory || this.conversationHistory;
    const currentContents: any[] = [];

    if (effectiveHistory && effectiveHistory.length > 0) {
      // Only the most recent turns go on the wire: the realtime path re-sends
      // this context on every final prospect segment, so unbounded context is
      // pure added latency. Stored history is not modified.
      for (const turn of effectiveHistory.slice(-this.maxContextTurns)) {
        if (turn.text) {
          currentContents.push({
            role: turn.role === "user" ? "user" : "model",
            parts: [{ text: turn.text }]
          });
        }
      }
    }

    currentContents.push({ role: "user", parts: [{ text: prospectPrompt }] });

    let turnsCount = 1;

    try {
      // 1st Model Turn: Determine need for business tools
      let response = await this.invokeModel(
        currentContents,
        activeAdapter.getSystemInstructions(),
        functionDeclarations
      );
      lastUsage = response.usage || lastUsage;

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
        response = await this.invokeModel(
          currentContents,
          activeAdapter.getSystemInstructions(),
          functionDeclarations
        );
        lastUsage = response.usage || lastUsage;
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
          const recoveryResponse = await this.invokeModel(
            recoveryContents,
            activeAdapter.getSystemInstructions(),
            []
          );
          lastUsage = recoveryResponse.usage || lastUsage;

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
          sessionId: session?.id,
          usage: lastUsage
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
   * Streaming recommendation pipeline.
   *
   * SECURITY: raw, unvalidated model tokens are NEVER forwarded to the caller.
   * The full model output is produced and run through the deterministic approval
   * gate first; only the validated statement (or the safe fallback for BLOCKED
   * results) is then emitted incrementally via `onValidatedDelta`. This gives the
   * UI incremental rendering without ever exposing unapproved claims.
   */
  public async generateRecommendationStream(
    prospectPrompt: string,
    adapterOrOptions: SalesApiAdapter | GenerateRecommendationOptions | undefined,
    onValidatedDelta: (delta: string) => void
  ): Promise<SalesRecommendation> {
    const recommendation = await this.generateRecommendation(prospectPrompt, adapterOrOptions);
    for (const chunk of GenericSalesEngine.chunkForStreaming(recommendation.statement || "")) {
      onValidatedDelta(chunk);
    }
    return recommendation;
  }

  /** Splits validated text into small chunks for incremental UI rendering. */
  public static chunkForStreaming(text: string, wordsPerChunk: number = 5): string[] {
    if (!text) return [];
    const tokens = text.split(/(\s+)/);
    const chunks: string[] = [];
    let current = "";
    let words = 0;
    for (const tok of tokens) {
      current += tok;
      if (/\S/.test(tok)) words++;
      if (words >= wordsPerChunk) {
        chunks.push(current);
        current = "";
        words = 0;
      }
    }
    if (current) chunks.push(current);
    return chunks;
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

      if (this.deterministicRouting) {
        const decision = decideRouting(trimmedText);
        if (!decision.invokeModel) {
          this.logger(
            "info",
            `Deterministic routing skipped model call (${decision.reason}): "${trimmedText}"`
          );
          return;
        }
      }

      const rec = await this.generateRecommendation(trimmedText);
      onRecommendationReady(rec);
    }
  }
}
