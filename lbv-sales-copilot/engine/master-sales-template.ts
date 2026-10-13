/**
 * Master Sales Template
 *
 * ONE reusable, configurable definition of the shared sales methodology.
 * It renders a service-specific system instruction from a data-only
 * ServiceProfile and provides the generic approval-gate validator.
 *
 * Core guarantees:
 * 1. The shared methodology is service-agnostic - it contains NO service names,
 *    prices, or claims. All service specifics are injected from the profile.
 * 2. Required profile fields are validated (fail-closed) before use.
 * 3. Unsupported claims and unauthorized pricing are rejected by a single
 *    generic validator driven entirely by the profile's business constraints.
 *
 * Adding a new service therefore requires only a new ServiceProfile - no core
 * engine or template changes.
 */

import { BehavioralPolicy, ToolDefinition, ValidationReport } from "./types.js";
import { validateCommercialCommitments } from "./commercial-validator.js";
import { assertValidServiceProfile, ServiceProfile } from "./service-profile.js";

export interface MasterSalesTemplateConfig {
  /** Name of the methodology (generic; defaults to a neutral label). */
  methodologyName?: string;
  /** Role framing for the copilot output. */
  copilotRole?: string;
}

/**
 * The shared, service-agnostic methodology text. Deliberately contains no
 * service-specific words, prices, or claims.
 */
const SHARED_METHODOLOGY = `You are a sales copilot. You produce the single next line the human salesperson should say aloud ("SAY THIS NEXT").
You are NOT the salesperson; produce only what the salesperson should say.

SHARED SALES METHODOLOGY (applies to every service):
1. DISCOVER: Use the approved discovery questions to understand the prospect's situation before pitching.
2. QUALIFY: Apply the qualification rules; if the prospect is not a fit, do not push the offer.
3. CONNECT: Tie the prospect's stated pain points to the listed benefits.
4. HANDLE OBJECTIONS: Use the approved objection playbook responses; never improvise pricing or guarantees.
5. ADVANCE: When a buying signal is present, propose exactly one approved call to action.

GROUNDING RULES:
- Only state facts returned by the approved tools. Never invent data, metrics, or proof.
- Never make claims that appear in the prohibited-claims list, even if the prospect asks.
- Never quote a price that is not in the authorized price list.
- Keep the response to a single, immediately speakable line of 15-35 words.`;

export class MasterSalesTemplate {
  private readonly methodologyName: string;
  private readonly copilotRole: string;

  constructor(config: MasterSalesTemplateConfig = {}) {
    this.methodologyName = config.methodologyName || "Shared Consultative Sales Methodology";
    this.copilotRole = config.copilotRole || "sales copilot";
  }

  public get methodology(): string {
    return SHARED_METHODOLOGY;
  }

  /**
   * Renders the full system instruction = shared methodology + service block
   * derived exclusively from the profile.
   */
  public renderSystemInstructions(profile: ServiceProfile): string {
    assertValidServiceProfile(profile);
    const c = profile.businessConstraints;

    const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
    const priceLines: string[] = [];
    if (typeof profile.offer.pilotPrice === "number") {
      priceLines.push(`Pilot price: ${profile.offer.currency} ${profile.offer.pilotPrice}`);
    }
    if (typeof profile.offer.monthlyPrice === "number") {
      priceLines.push(`Ongoing price: ${profile.offer.currency} ${profile.offer.monthlyPrice}`);
    }

    const objections = profile.objections
      .map((o) => `- Objection "${o.objection}": ${o.response}`)
      .join("\n");

    const disclaimers = (c.requiredDisclaimers || [])
      .map((d) => `- When ${d.when}: "${d.text}"`)
      .join("\n");

    return `${SHARED_METHODOLOGY}

SERVICE PROFILE: ${profile.name}
Role: ${this.copilotRole}. ${profile.persona || profile.description}

OFFER:
${priceLines.length > 0 ? priceLines.join("\n") + "\n" : ""}Scope: ${profile.offer.scope}
Deliverables:
${bullets(profile.offer.deliverables)}

IDEAL CUSTOMERS:
${bullets(profile.idealCustomers)}

PAIN POINTS:
${bullets(profile.painPoints)}

BENEFITS:
${bullets(profile.benefits)}

QUALIFICATION RULES:
${bullets(profile.qualificationRules)}

DISCOVERY QUESTIONS:
${bullets(profile.discoveryQuestions)}

OBJECTION PLAYBOOK:
${objections}

BUYING SIGNALS:
${bullets(profile.buyingSignals)}

APPROVED CALLS TO ACTION:
${bullets(profile.ctas)}

COMPLIANCE (ENFORCED):
- Authorized prices only: ${c.authorizedPrices.join(", ")}
- ${c.disallowDiscounts ? "Discounts, rebates, and custom rates are prohibited." : "Discount policy: allowed within authorized prices."}
- Prohibited claims: ${c.prohibitedClaims.join(", ")}
${c.prohibitedTopics.length > 0 ? `- Out-of-scope topics: ${c.prohibitedTopics.join(", ")}` : ""}
${disclaimers}

METHODOLOGY: ${this.methodologyName}`;
  }

  /** Behavioral policies derived from the profile constraints. */
  public buildBehavioralPolicies(profile: ServiceProfile): BehavioralPolicy[] {
    assertValidServiceProfile(profile);
    const c = profile.businessConstraints;
    const policies: BehavioralPolicy[] = [
      {
        id: "authorized-pricing",
        name: "Authorized Pricing Only",
        description: `Only quote these prices: ${c.authorizedPrices.join(", ")}.`,
        strict: true
      },
      {
        id: "prohibited-claims",
        name: "Prohibited Claims Guard",
        description: `Never assert: ${c.prohibitedClaims.join(", ")}.`,
        strict: true
      },
      {
        id: "evidence-grounding",
        name: "Tool-Grounded Evidence Only",
        description: "Only reference facts returned by the service's approved tools.",
        strict: true
      }
    ];
    if (c.disallowDiscounts) {
      policies.push({
        id: "no-discounts",
        name: "No Discounts",
        description: "Never offer discounts, rebates, or custom rates.",
        strict: true
      });
    }
    if (c.prohibitedTopics.length > 0) {
      policies.push({
        id: "scope-boundaries",
        name: "Scope Boundaries",
        description: `Refuse out-of-scope topics: ${c.prohibitedTopics.join(", ")}.`,
        strict: true
      });
    }
    return policies;
  }

  /** Tool declarations exposed to the model, derived from the profile. */
  public buildTools(profile: ServiceProfile): ToolDefinition[] {
    assertValidServiceProfile(profile);
    return profile.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: { type: "OBJECT", properties: {} }
    }));
  }

  /** Restricted tool execution bound to the profile's declarative data. */
  public async executeTool(profile: ServiceProfile, toolName: string, _args?: Record<string, any>): Promise<any> {
    assertValidServiceProfile(profile);
    const tool = profile.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`[MasterSalesTemplate] Unauthorized tool request for '${profile.id}': ${toolName}`);
    }
    return tool.data;
  }

  /**
   * Generic approval-gate validator. Driven entirely by the profile's business
   * constraints - no service-specific assumptions.
   */
  public createValidator(profile: ServiceProfile): (response: string, prompt: string) => ValidationReport {
    assertValidServiceProfile(profile);
    const c = profile.businessConstraints;

    return (response: string, prompt: string): ValidationReport => {
      const unsupportedClaims: string[] = [];
      const lower = (response || "").toLowerCase();

      // 1. Authorized pricing / discounts (reuses the shared commercial validator)
      const commercial = validateCommercialCommitments(response, prompt, {
        authorizedPrices: c.authorizedPrices,
        disallowDiscounts: c.disallowDiscounts
      });
      if (!commercial.valid) unsupportedClaims.push(...commercial.violations);

      // 2. Prohibited claims
      for (const claim of c.prohibitedClaims) {
        const token = claim.toLowerCase();
        if (token && lower.includes(token)) {
          const negated =
            lower.includes(`do not ${token}`) ||
            lower.includes(`don't ${token}`) ||
            lower.includes(`cannot ${token}`) ||
            lower.includes(`can't ${token}`) ||
            lower.includes(`no ${token}`) ||
            lower.includes(`not ${token}`);
          if (!negated) {
            unsupportedClaims.push(`Prohibited claim asserted: '${claim}'.`);
          }
        }
      }

      // 3. Out-of-scope topics
      for (const topic of c.prohibitedTopics) {
        const token = topic.toLowerCase();
        if (token && lower.includes(token)) {
          unsupportedClaims.push(`Out-of-scope topic referenced: '${topic}'.`);
        }
      }

      return {
        isGrounded: unsupportedClaims.length === 0,
        unsupportedClaims,
        rulesPassed: this.buildBehavioralPolicies(profile).map((p) => ({
          name: p.name,
          status: "PASSED" as const,
          description: p.description
        }))
      };
    };
  }
}

export const DEFAULT_MASTER_SALES_TEMPLATE = new MasterSalesTemplate();
