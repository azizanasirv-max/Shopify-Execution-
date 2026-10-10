/**
 * Product-Specific Sales API: Shopify Implementation
 *
 * Implements the SalesApiAdapter interface for Shopify Storefront Optimization & Audits.
 *
 * Supplies:
 * - Service definitions (Storefront conversion hygiene, mobile checkout friction, Google listing hours)
 * - Strict pricing ($400 pilot, $900/mo ongoing)
 * - Pilot scope (testing only, no full rebuilds/paid ads/email marketing)
 * - Evidence grounding (audit-screenshot-01, audit-screenshot-02)
 * - Tool definitions & execution: getProspect, getAudit, getEvidence, getOffer
 * - Policy validation via validateResponse
 */

import {
  SalesApiAdapter,
  ToolDefinition,
  BehavioralPolicy,
  ValidationReport
} from "../engine/types.js";
import {
  SALES_SYSTEM_INSTRUCTIONS,
  validateResponse as validateShopifyResponse
} from "../lib/sales-context.js";

const DEFAULT_PROSPECT_DATA = {
  prospect: {
    name: "Example Fashion Store",
    industry: "Fashion",
    platform: "Shopify",
    revenueBand: "$1M-$5M",
    googleReviews: 312,
    googleRating: 4.7,
    websiteStatus: "active"
  },
  audit: {
    finding: "Example finding for validation only"
  },
  evidence: [
    {
      id: "audit-screenshot-01",
      type: "outdated_listing",
      description: "Google Maps Listing shows incorrect Saturday business hours, conflicting with active Shopify site announcement.",
      impact: "Potential lost walk-in traffic and negative customer service friction"
    },
    {
      id: "audit-screenshot-02",
      type: "conversion_friction",
      description: "Checkout flow has high friction due to missing express checkout options on mobile devices.",
      impact: "Decreased mobile purchase completion rates"
    }
  ],
  offer: {
    pilotPrice: 400,
    monthlyPrice: 900,
    pilotScope: "Defined pilot scope for testing"
  },
  unsupportedMetrics: {
    actualRevenue: "UNAVAILABLE",
    conversionRate: "UNAVAILABLE",
    profit: "UNAVAILABLE",
    cac: "UNAVAILABLE",
    customerCount: "UNAVAILABLE"
  }
};

export class ShopifySalesAdapter implements SalesApiAdapter {
  public readonly id = "shopify-conversion-pilot";
  public readonly name = "Shopify Storefront Optimization Pilot";
  public readonly description = "Storefront conversion hygiene audit and rapid mobile friction remediation for Shopify merchants.";

  private prospectData: any = DEFAULT_PROSPECT_DATA;

  constructor(customData?: any) {
    if (customData) {
      this.prospectData = customData;
    }
  }

  private loadData(): void {
    if (!this.prospectData) {
      this.prospectData = DEFAULT_PROSPECT_DATA;
    }
  }

  public getSystemInstructions(): string {
    return SALES_SYSTEM_INSTRUCTIONS;
  }

  public getBehavioralPolicies(): BehavioralPolicy[] {
    return [
      {
        id: "no-financial-guarantees",
        name: "Prohibit Revenue & ROI Guarantees",
        description: "Never guarantee any specific financial return, revenue increase, or conversion rate lift.",
        strict: true
      },
      {
        id: "firm-pilot-pricing",
        name: "Fixed Pilot & Monthly Pricing",
        description: "Enforce exact pricing: $400 pilot price, $900 monthly retainer. Reject all discounts and rebates.",
        strict: true
      },
      {
        id: "firm-pilot-scope",
        name: "Strict Scope Boundaries",
        description: "Commit strictly to defined storefront testing hygiene. Refuse store rebuilds, ads, or email marketing.",
        strict: true
      },
      {
        id: "evidence-grounding",
        name: "Visual Evidence Grounding",
        description: "Only cite verified audit screenshots (audit-screenshot-01, audit-screenshot-02). Never claim visual proof of CAC or revenue.",
        strict: true
      },
      {
        id: "private-metrics-protection",
        name: "Unavailable Metrics Guard",
        description: "Explicitly declare internal metrics (actual revenue, profit, conversion rate, CAC, customer count) as confidential/unavailable.",
        strict: true
      }
    ];
  }

  public getTools(): ToolDefinition[] {
    return [
      {
        name: "getProspect",
        description: "Get general store profile details for the target prospect store (name, industry, platform, revenue band, active status, google reviews count and ratings).",
        parameters: {
          type: "OBJECT",
          properties: {}
        }
      },
      {
        name: "getAudit",
        description: "Get the main technical audit finding for the prospect store.",
        parameters: {
          type: "OBJECT",
          properties: {}
        }
      },
      {
        name: "getEvidence",
        description: "Get visual proof and store error items demonstrating specific friction points on the site or Google listing.",
        parameters: {
          type: "OBJECT",
          properties: {}
        }
      },
      {
        name: "getOffer",
        description: "Get pricing details for the pilot price, monthly price, and pilot scope of work.",
        parameters: {
          type: "OBJECT",
          properties: {}
        }
      }
    ];
  }

  public async executeTool(toolName: string, _args?: Record<string, any>): Promise<any> {
    if (!this.prospectData) {
      this.loadData();
    }

    if (!this.prospectData) {
      throw new Error(`[ShopifySalesAdapter] Prospect data source unavailable for tool: ${toolName}`);
    }

    switch (toolName) {
      case "getProspect":
        return this.prospectData.prospect;
      case "getAudit":
        return this.prospectData.audit;
      case "getEvidence":
        return this.prospectData.evidence;
      case "getOffer":
        return this.prospectData.offer;
      default:
        throw new Error(`[ShopifySalesAdapter] Unrecognized or unauthorized tool execution request: ${toolName}`);
    }
  }

  public validateResponse(response: string, prompt: string): ValidationReport {
    return validateShopifyResponse(response, prompt);
  }

  public getProductContext(): Record<string, any> {
    if (!this.prospectData) {
      this.loadData();
    }
    return this.prospectData || {};
  }
}
