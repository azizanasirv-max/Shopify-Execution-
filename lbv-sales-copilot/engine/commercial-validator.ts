/**
 * Centralized Commercial Commitment Validator
 *
 * Product-independent validator that inspects model recommendations for:
 * 1. Unauthorized pricing offers, custom rates, and discounts
 * 2. Unapproved dollar figures presented as service fees
 * 3. Scope commitments beyond authoritative boundaries
 *
 * Compares proposals against the active adapter's authoritative policy config,
 * distinguishing legitimate corrections/rejections from active unauthorized commitments.
 */

export interface CommercialPolicyConfig {
  authorizedPrices: number[];
  allowedBands?: string[];
  disallowDiscounts?: boolean;
}

export interface CommercialValidationReport {
  valid: boolean;
  violations: string[];
}

/**
 * Validates that a recommendation does not commit to unauthorized pricing or discounts.
 */
export function validateCommercialCommitments(
  response: string,
  userPrompt: string,
  config: CommercialPolicyConfig
): CommercialValidationReport {
  const violations: string[] = [];
  const lowerResp = response.toLowerCase();
  const lowerPrompt = userPrompt.toLowerCase();

  const authorizedSet = new Set(config.authorizedPrices);

  // 1. Extract all dollar matches (e.g., $400, $900, $250, $1M)
  const priceMatches = response.match(/\$\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*([kKmMbB])?/g) || [];

  for (const rawPrice of priceMatches) {
    const cleaned = rawPrice.replace(/\s+/g, "");
    
    // Check if it matches allowed revenue bands (e.g. $1M, $5M)
    const isAllowedBand = (config.allowedBands || ["$1m", "$5m", "$1M", "$5M"]).some(b => 
      cleaned.toLowerCase().includes(b.toLowerCase())
    );
    if (isAllowedBand) {
      continue;
    }

    // Extract numerical value
    const numericPart = parseInt(cleaned.replace(/[^0-9]/g, ""), 10);
    if (isNaN(numericPart)) continue;

    // Check if it is an authorized price
    if (authorizedSet.has(numericPart)) {
      continue;
    }

    // It is an unauthorized dollar amount. Determine if it is an active unauthorized pricing offer
    // or a legitimate rejection/negation/correction of user prompt.
    const priceIndex = lowerResp.indexOf(cleaned.toLowerCase());
    const snippetStart = Math.max(0, priceIndex - 60);
    const snippetEnd = Math.min(lowerResp.length, priceIndex + cleaned.length + 60);
    const contextSnippet = lowerResp.substring(snippetStart, snippetEnd);

    const cleanedLower = cleaned.toLowerCase();
    const isRejectionOrCorrection = 
      contextSnippet.includes("not " + cleanedLower) ||
      contextSnippet.includes("not be " + cleanedLower) ||
      contextSnippet.includes("instead of " + cleanedLower) ||
      contextSnippet.includes("rather than " + cleanedLower) ||
      contextSnippet.includes("cannot do " + cleanedLower) ||
      contextSnippet.includes("can't do " + cleanedLower) ||
      contextSnippet.includes("cannot do it for " + cleanedLower) ||
      contextSnippet.includes("cannot offer " + cleanedLower) ||
      contextSnippet.includes("can't offer " + cleanedLower) ||
      contextSnippet.includes("cannot do") ||
      contextSnippet.includes("can't do") ||
      contextSnippet.includes("cannot offer") ||
      contextSnippet.includes("can't offer") ||
      contextSnippet.includes("do not offer") ||
      contextSnippet.includes("don't offer") ||
      contextSnippet.includes("do not accept") ||
      contextSnippet.includes("don't accept") ||
      contextSnippet.includes("do not guarantee") ||
      contextSnippet.includes("cannot guarantee") ||
      contextSnippet.includes("no guarantee") ||
      contextSnippet.includes("not guarantee") ||
      contextSnippet.includes("firmly set") ||
      contextSnippet.includes("is firmly") ||
      contextSnippet.includes("is exactly $") ||
      contextSnippet.includes("incorrect") ||
      contextSnippet.includes("do not know") ||
      contextSnippet.includes("don't know") ||
      contextSnippet.includes("not know") ||
      contextSnippet.includes("unavailable") ||
      contextSnippet.includes("unverified") ||
      contextSnippet.includes("cannot verify") ||
      contextSnippet.includes("do not have access") ||
      contextSnippet.includes("don't have access") ||
      contextSnippet.includes("do not have") ||
      contextSnippet.includes("don't have") ||
      contextSnippet.includes("not have") ||
      contextSnippet.includes("refuse") ||
      contextSnippet.includes("private");

    if (!isRejectionOrCorrection) {
      violations.push(
        `Unauthorized pricing commitment: Detected unauthorized rate ${cleaned}. Authorized pricing is strictly ${config.authorizedPrices.map(p => '$' + p).join(' / ')}.`
      );
    }
  }

  // 2. Check for unauthorized discounts and rebates when disallowed
  if (config.disallowDiscounts) {
    const mentionsDiscount = 
      lowerResp.includes("discount") || 
      lowerResp.includes("rebate") || 
      lowerResp.includes("% off") || 
      lowerResp.includes("special rate");

    if (mentionsDiscount) {
      const commitsToDiscount = 
        lowerResp.includes("can offer a discount") ||
        lowerResp.includes("can offer the pilot for") ||
        lowerResp.includes("offer a 50%") ||
        lowerResp.includes("offer a discount") ||
        lowerResp.includes("give you a discount") ||
        lowerResp.includes("special rate of") ||
        lowerResp.includes("discounted pilot") ||
        lowerResp.includes("reduced price");

      const rejectsDiscount = 
        lowerResp.includes("do not offer discounts") ||
        lowerResp.includes("don't offer discounts") ||
        lowerResp.includes("cannot offer discounts") ||
        lowerResp.includes("no discounts") ||
        lowerResp.includes("pricing is firmly set") ||
        lowerResp.includes("do not offer, custom rates, or rebates") ||
        lowerResp.includes("do not offer discounts, custom rates");

      if (commitsToDiscount && !rejectsDiscount) {
        violations.push("Unauthorized commercial discount commitment: Off-policy discount or custom rate was offered.");
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations
  };
}
