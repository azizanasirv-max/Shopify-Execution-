/**
 * Profile-Backed Sales Adapter
 *
 * Implements the existing SalesApiAdapter contract purely from a data-only
 * ServiceProfile plus the shared MasterSalesTemplate. This is the ONLY adapter
 * class needed for any new service: adding a service = adding a profile.
 *
 * The core engine, provider layer, approval gate, session management, and
 * persistence remain untouched.
 */

import { BehavioralPolicy, SalesApiAdapter, ToolDefinition, ValidationReport } from "./types.js";
import { assertValidServiceProfile, ServiceProfile } from "./service-profile.js";
import { MasterSalesTemplate, DEFAULT_MASTER_SALES_TEMPLATE } from "./master-sales-template.js";

export class ProfileBackedSalesAdapter implements SalesApiAdapter {
  public readonly id: string;
  public readonly name: string;
  public readonly description: string;

  private readonly profile: ServiceProfile;
  private readonly template: MasterSalesTemplate;
  private readonly validator: (response: string, prompt: string) => ValidationReport;

  constructor(profile: ServiceProfile, template: MasterSalesTemplate = DEFAULT_MASTER_SALES_TEMPLATE) {
    // Fail closed on invalid configuration before anything is served.
    assertValidServiceProfile(profile);
    this.profile = profile;
    this.template = template;
    this.id = profile.id;
    this.name = profile.name;
    this.description = profile.description;
    this.validator = template.createValidator(profile);
  }

  /** Exposes the underlying profile for inspection/telemetry. */
  public getProfile(): ServiceProfile {
    return this.profile;
  }

  public getSystemInstructions(): string {
    return this.template.renderSystemInstructions(this.profile);
  }

  public getBehavioralPolicies(): BehavioralPolicy[] {
    return this.template.buildBehavioralPolicies(this.profile);
  }

  public getTools(): ToolDefinition[] {
    return this.template.buildTools(this.profile);
  }

  public async executeTool(toolName: string, args?: Record<string, any>): Promise<any> {
    return this.template.executeTool(this.profile, toolName, args);
  }

  public validateResponse(response: string, prompt: string): ValidationReport {
    return this.validator(response, prompt);
  }

  public getProductContext(): Record<string, any> {
    return this.profile.context || {};
  }
}
