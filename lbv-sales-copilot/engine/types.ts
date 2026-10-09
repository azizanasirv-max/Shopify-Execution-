/**
 * Product-Independent Sales Engine - Core Types and Interfaces
 *
 * Provides a clean architectural abstraction separating:
 * 1. Generic Sales Engine (conversation orchestration, model integration, restricted tool loop, recommendations)
 * 2. Sales API Adapter Interface (product-agnostic contract for business data, tools, instructions, and policy validation)
 * 3. Realtime Adapter Interface (LiveKit silent copilot integration without publishing AI audio)
 */

export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ToolCallResult {
  tool: string;
  args?: Record<string, any>;
  result: any;
  latencyMs?: number;
}

export interface PolicyRuleStatus {
  name: string;
  status: "PASSED" | "FAILED";
  description: string;
}

export interface ValidationReport {
  isGrounded: boolean;
  unsupportedClaims: string[];
  rulesPassed: PolicyRuleStatus[];
}

export interface BehavioralPolicy {
  id: string;
  name: string;
  description: string;
  strict: boolean;
}

/**
 * Standard recommendation output produced by the Generic Sales Engine
 */
export interface SalesRecommendation {
  statement: string;
  toolsUsed: ToolCallResult[];
  validationReport: ValidationReport;
  timestamp: number;
  engineMetadata: {
    model: string;
    productId: string;
    latencyMs: number;
    turnsCount: number;
  };
}

/**
 * Interface through which the Generic Sales Engine retrieves
 * business-specific information and invokes approved business operations.
 * The engine MUST NOT assume a particular product or service.
 */
export interface SalesApiAdapter {
  /** Unique identifier for the product or service offering (e.g. 'shopify-pilot', 'ghostwriter') */
  readonly id: string;
  
  /** Display name of the product or service */
  readonly name: string;
  
  /** High-level summary of the offering */
  readonly description: string;

  /**
   * Generates or returns the system instructions and behavioral constraints
   * specific to this business offering.
   */
  getSystemInstructions(): string;

  /**
   * Returns configured behavioral policies enforced for this offering.
   */
  getBehavioralPolicies(): BehavioralPolicy[];

  /**
   * Returns approved tool declarations exposed to the language model.
   */
  getTools(): ToolDefinition[];

  /**
   * Executes an approved tool in a restricted sandbox.
   * Throws an error if an unapproved tool name is requested.
   */
  executeTool(toolName: string, args?: Record<string, any>): Promise<any>;

  /**
   * Validates generated response against product-specific grounding and compliance rules.
   */
  validateResponse(response: string, prompt: string): ValidationReport;

  /**
   * Optional method to retrieve underlying prospect/service context for UI dashboards or testing.
   */
  getProductContext?(): Record<string, any>;
}

/**
 * Realtime events consumed by or emitted to LiveKit integration
 */
export interface RealtimeTranscriptEvent {
  speaker: "prospect" | "salesperson" | "system";
  text: string;
  isFinal: boolean;
  timestamp: number;
}

export interface RealtimeCopilotMessage {
  type: "recommendation" | "status" | "error";
  recommendation?: SalesRecommendation;
  status?: "idle" | "listening" | "analyzing" | "ready";
  roomName: string;
  timestamp: number;
}

export interface RealtimeAdapterConfig {
  livekitUrl?: string;
  apiKey?: string;
  apiSecret?: string;
  roomName: string;
  identity: string;
}
