/**
 * Standardized Service Profile contract.
 *
 * A ServiceProfile is a pure, data-only description of the service being sold.
 * It carries every service-specific fact the sales methodology needs (offers,
 * ideal customers, pain points, benefits, qualification, discovery questions,
 * objections, buying signals, CTAs, and business constraints) WITHOUT any
 * sales-methodology logic. The shared methodology lives in the master template,
 * so changing services means adding/updating a profile - never rewriting the
 * core engine.
 *
 * The master template and the core engine MUST NOT reference any service by
 * name; all service specifics flow through this structure.
 */

export interface ServiceOffer {
  /** One-time pilot / engagement price, if any. */
  pilotPrice?: number | null;
  /** Recurring retainer price, if any. */
  monthlyPrice?: number | null;
  /** ISO currency code, e.g. "USD". */
  currency: string;
  /** Human-readable scope of work for the pilot/engagement. */
  scope: string;
  /** Explicit deliverables. */
  deliverables: string[];
  /** Optional terms/notes (no pricing numbers required here). */
  terms?: string;
}

export interface ObjectionPlaybook {
  /** Short label for the objection, e.g. "too expensive". */
  objection: string;
  /** Recommended compliant handling for the salesperson. */
  response: string;
}

export interface ServiceBusinessConstraints {
  /** Every price the salesperson is authorized to quote. */
  authorizedPrices: number[];
  /** Whether discounts/rebates/custom rates are forbidden. */
  disallowDiscounts: boolean;
  /** Claim tokens that must never be asserted (e.g. "guarantee", "viral"). */
  prohibitedClaims: string[];
  /** Topics explicitly out of scope for this service. */
  prohibitedTopics: string[];
  /** Optional mandatory disclaimers. */
  requiredDisclaimers?: { when: string; text: string }[];
}

export interface ServiceToolSpec {
  name: string;
  description: string;
  /** Declarative tool result data. Keeps profiles data-only. */
  data: any;
}

export interface ServiceProfile {
  /** Canonical identifier (lowercase, hyphenated). */
  id: string;
  name: string;
  description: string;
  /** Alternate identifiers for registry resolution. */
  aliases?: string[];
  /** Who the service is ideal for. */
  idealCustomers: string[];
  /** Problems the ideal customer feels. */
  painPoints: string[];
  /** Outcomes the service delivers. */
  benefits: string[];
  /** Deterministic qualification rules (when NOT to sell). */
  qualificationRules: string[];
  /** Discovery questions the salesperson should ask. */
  discoveryQuestions: string[];
  /** Objection handling playbook. */
  objections: ObjectionPlaybook[];
  /** Signals that the prospect is ready to buy. */
  buyingSignals: string[];
  /** Approved calls to action. */
  ctas: string[];
  /** Offer and commercial constraints. */
  offer: ServiceOffer;
  /** Hard business constraints used by the validator. */
  businessConstraints: ServiceBusinessConstraints;
  /** Tools exposed to the model for this service. */
  tools: ServiceToolSpec[];
  /** Optional free-form context returned by getProductContext(). */
  context?: Record<string, any>;
  /** Optional persona framing appended to the methodology. */
  persona?: string;
}

export class ServiceProfileValidationError extends Error {
  public readonly code = "INVALID_SERVICE_PROFILE";
  constructor(public readonly profileId: string, public readonly errors: string[]) {
    super(`Invalid service profile '${profileId}': ${errors.join("; ")}`);
    this.name = "ServiceProfileValidationError";
  }
}

function isNonEmptyString(v: any): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isNonEmptyStringArray(v: any): boolean {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

/**
 * Validates required configuration fields. Returns a list of human-readable
 * errors (empty when the profile is valid). Fail-closed: callers throw on a
 * non-empty list.
 */
export function validateServiceProfile(profile: any): string[] {
  const errors: string[] = [];
  if (!profile || typeof profile !== "object") {
    return ["profile must be an object"];
  }

  if (!isNonEmptyString(profile.id) || !/^[a-z0-9][a-z0-9-]*$/.test(profile.id)) {
    errors.push("id must be a non-empty lowercase hyphenated identifier");
  }
  if (!isNonEmptyString(profile.name)) errors.push("name is required");
  if (!isNonEmptyString(profile.description)) errors.push("description is required");

  const requiredArrays: [string, any][] = [
    ["idealCustomers", profile.idealCustomers],
    ["painPoints", profile.painPoints],
    ["benefits", profile.benefits],
    ["qualificationRules", profile.qualificationRules],
    ["discoveryQuestions", profile.discoveryQuestions],
    ["buyingSignals", profile.buyingSignals],
    ["ctas", profile.ctas]
  ];
  for (const [field, value] of requiredArrays) {
    if (!isNonEmptyStringArray(value)) errors.push(`${field} must be a non-empty array of strings`);
  }

  // Offer
  const offer = profile.offer;
  if (!offer || typeof offer !== "object") {
    errors.push("offer is required");
  } else {
    if (!isNonEmptyString(offer.currency)) errors.push("offer.currency is required");
    if (!isNonEmptyString(offer.scope)) errors.push("offer.scope is required");
    if (!isNonEmptyStringArray(offer.deliverables)) errors.push("offer.deliverables must be a non-empty array of strings");
  }

  // Objections
  if (!Array.isArray(profile.objections) || profile.objections.length === 0) {
    errors.push("objections must be a non-empty array");
  } else {
    profile.objections.forEach((o: any, i: number) => {
      if (!o || !isNonEmptyString(o.objection) || !isNonEmptyString(o.response)) {
        errors.push(`objections[${i}] must have non-empty 'objection' and 'response'`);
      }
    });
  }

  // Business constraints
  const c = profile.businessConstraints;
  if (!c || typeof c !== "object") {
    errors.push("businessConstraints is required");
  } else {
    if (!Array.isArray(c.authorizedPrices) || c.authorizedPrices.length === 0 || !c.authorizedPrices.every((p: any) => typeof p === "number" && p > 0)) {
      errors.push("businessConstraints.authorizedPrices must be a non-empty array of positive numbers");
    }
    if (typeof c.disallowDiscounts !== "boolean") {
      errors.push("businessConstraints.disallowDiscounts must be a boolean");
    }
    if (!isNonEmptyStringArray(c.prohibitedClaims)) {
      errors.push("businessConstraints.prohibitedClaims must be a non-empty array of strings");
    }
    if (c.prohibitedTopics !== undefined && !Array.isArray(c.prohibitedTopics)) {
      errors.push("businessConstraints.prohibitedTopics must be an array when provided");
    }
  }

  // Tools
  if (!Array.isArray(profile.tools) || profile.tools.length === 0) {
    errors.push("tools must be a non-empty array");
  } else {
    const seen = new Set<string>();
    profile.tools.forEach((t: any, i: number) => {
      if (!t || !isNonEmptyString(t.name)) {
        errors.push(`tools[${i}].name is required`);
      } else if (seen.has(t.name)) {
        errors.push(`tools[${i}].name '${t.name}' is duplicated`);
      } else {
        seen.add(t.name);
      }
      if (!t || !isNonEmptyString(t.description)) errors.push(`tools[${i}].description is required`);
    });
  }

  // Price/constraint coherence: quoted prices must be authorized.
  if (offer && Array.isArray(c?.authorizedPrices)) {
    const authorized = new Set(c.authorizedPrices);
    if (typeof offer.pilotPrice === "number" && !authorized.has(offer.pilotPrice)) {
      errors.push(`offer.pilotPrice (${offer.pilotPrice}) is not present in businessConstraints.authorizedPrices`);
    }
    if (typeof offer.monthlyPrice === "number" && !authorized.has(offer.monthlyPrice)) {
      errors.push(`offer.monthlyPrice (${offer.monthlyPrice}) is not present in businessConstraints.authorizedPrices`);
    }
  }

  return errors;
}

/** Throws ServiceProfileValidationError when the profile is invalid. */
export function assertValidServiceProfile(profile: any): void {
  const errors = validateServiceProfile(profile);
  if (errors.length > 0) {
    const id = profile && typeof profile.id === "string" ? profile.id : "<unknown>";
    throw new ServiceProfileValidationError(id, errors);
  }
}
