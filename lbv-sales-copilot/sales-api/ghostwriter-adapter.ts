/**
 * Product-Specific Sales API: Ghostwriter Implementation (Alternative Product)
 *
 * Demonstrates product independence:
 * Integrates an entirely different high-ticket service (Executive Ghostwriting & Thought Leadership)
 * into the Generic Sales Engine without changing any core engine code.
 *
 * Supplies:
 * - Service definitions (Executive LinkedIn & Newsletter ghostwriting)
 * - Pilot pricing ($1,200 pilot, $2,500/mo retainer)
 * - Pilot scope (4 long-form essays, executive voice interview)
 * - Writing samples & portfolio verification
 * - Product-specific tool definitions & restricted execution
 * - Product-specific compliance rules & validator
 */

import {
  SalesApiAdapter,
  ToolDefinition,
  BehavioralPolicy,
  ValidationReport
} from "../engine/types.js";

export class GhostwriterSalesAdapter implements SalesApiAdapter {
  public readonly id = "ghostwriter-thought-leadership";
  public readonly name = "Ghostwriter Executive Thought Leadership";
  public readonly description = "High-touch executive ghostwriting and personal brand authority for founders and tech leaders.";

  private ghostwriterData = {
    prospect: {
      clientName: "SaaS Founder / CTO",
      targetAudience: "Enterprise Buyers & Investors",
      primaryPlatform: "LinkedIn & Substack",
      currentFollowers: "4,200",
      publishingFrequency: "Irregular"
    },
    audit: {
      finding: "Strong domain insights but low engagement due to technical jargon and lack of narrative hook structure."
    },
    portfolio: [
      {
        id: "sample-essay-01",
        title: "The Zero-Click Search Economy",
        impressions: "45,000 views, 340 shares",
        niche: "B2B SaaS"
      },
      {
        id: "sample-essay-02",
        title: "Why Most Tech Roadmaps Fail",
        impressions: "28,000 views, 190 shares",
        niche: "Engineering Leadership"
      }
    ],
    offer: {
      pilotPrice: 1200,
      monthlyPrice: 2500,
      pilotScope: "4 long-form executive essays with 60-min voice discovery interview and 2 revision cycles."
    }
  };

  public getSystemInstructions(): string {
    return `
You are the Sales Brain (Sales Copilot) for a high-performing salesperson selling "Ghostwriter Executive Thought Leadership".
Your task is to produce the recommended next statement ("SAY THIS NEXT") that a human salesperson can say aloud to a founder or executive prospect.
You are a sales copilot, NOT the direct salesperson. You must produce exactly what the salesperson should say.

MANDATORY TOOL CALLING RULES:
1. PRICING & SCOPE: Before answering any question about ghostwriting price, retainer, pilot cost, or scope, call "getGhostwriterOffer".
2. AUDIT: Before commenting on the prospect's profile or content friction, call "getEditorialAudit".
3. PORTFOLIO & SAMPLES: Before discussing previous writing results or case studies, call "getWritingSamples".
4. PROSPECT: Before discussing audience or publishing details, call "getExecutiveProfile".

CRITICAL COMPLIANCE RULES:
1. NO VIRALITY GUARANTEES: Never guarantee viral posts, specific follower growth, or lead counts. State: "We do not guarantee viral engagement or follower counts. We guarantee high-fidelity executive writing and consistent publishing cadence."
2. FIRM PRICING: Pilot is strictly $1,200, and ongoing retainer is $2,500/month. No discounts.
3. FIRM SCOPE: The pilot covers 4 long-form essays and voice interview. It does not include video production, podcast editing, or personal PR pitching.
4. Format your recommendation clearly under "SAY THIS NEXT".
`;
  }

  public getBehavioralPolicies(): BehavioralPolicy[] {
    return [
      {
        id: "no-virality-guarantees",
        name: "Prohibit Virality / Follower Guarantees",
        description: "Never guarantee virality or follower counts.",
        strict: true
      },
      {
        id: "firm-pricing",
        name: "Fixed Retainer Pricing",
        description: "Enforce exact pricing: $1,200 pilot, $2,500/month ongoing.",
        strict: true
      },
      {
        id: "firm-scope",
        name: "Strict Editorial Scope",
        description: "Limit scope to 4 essays and voice interview. Refuse video/PR tasks.",
        strict: true
      }
    ];
  }

  public getTools(): ToolDefinition[] {
    return [
      {
        name: "getExecutiveProfile",
        description: "Get profile and audience info for the prospective executive author.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "getEditorialAudit",
        description: "Get editorial audit of the prospect's current content and messaging weaknesses.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "getWritingSamples",
        description: "Get verified writing samples and case study metrics from the ghostwriter portfolio.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "getGhostwriterOffer",
        description: "Get pricing details ($1,200 pilot, $2,500/mo) and editorial pilot scope.",
        parameters: { type: "OBJECT", properties: {} }
      }
    ];
  }

  public async executeTool(toolName: string, _args?: Record<string, any>): Promise<any> {
    switch (toolName) {
      case "getExecutiveProfile":
        return this.ghostwriterData.prospect;
      case "getEditorialAudit":
        return this.ghostwriterData.audit;
      case "getWritingSamples":
        return this.ghostwriterData.portfolio;
      case "getGhostwriterOffer":
        return this.ghostwriterData.offer;
      default:
        throw new Error(`[GhostwriterSalesAdapter] Unauthorized tool request: ${toolName}`);
    }
  }

  public validateResponse(response: string, _prompt: string): ValidationReport {
    const unsupportedClaims: string[] = [];
    const lower = response.toLowerCase();

    // Check no virality guarantees
    if (lower.includes("guarantee") && (lower.includes("follower") || lower.includes("viral") || lower.includes("leads"))) {
      if (!lower.includes("do not guarantee") && !lower.includes("cannot guarantee") && !lower.includes("no guarantee")) {
        unsupportedClaims.push("Guaranteed viral reach or follower numbers.");
      }
    }

    // Check firm pricing ($1200 pilot, $2500 retainer)
    if (lower.includes("discount") && (lower.includes("can offer") || lower.includes("reduced"))) {
      unsupportedClaims.push("Offered unauthorized discount on ghostwriting services.");
    }

    return {
      isGrounded: unsupportedClaims.length === 0,
      unsupportedClaims,
      rulesPassed: [
        {
          name: "Virality Guard",
          status: unsupportedClaims.some(c => c.includes("Guaranteed")) ? "FAILED" : "PASSED",
          description: "Never guarantee viral engagement or follower growth."
        },
        {
          name: "Firm Pricing",
          status: unsupportedClaims.some(c => c.includes("discount")) ? "FAILED" : "PASSED",
          description: "Must maintain firm $1,200 pilot and $2,500/mo pricing."
        }
      ]
    };
  }

  public getProductContext(): Record<string, any> {
    return this.ghostwriterData;
  }
}
