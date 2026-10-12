/**
 * Representative service profile: Shopify storefront optimization.
 *
 * Data-only. Contains NO sales-methodology logic - that lives in the shared
 * master template.
 */

import { ServiceProfile } from "../../engine/service-profile.js";

export const SHOPIFY_SERVICE_PROFILE: ServiceProfile = {
  id: "shopify-service-profile",
  name: "Shopify Storefront Optimization Pilot",
  description: "Storefront conversion hygiene audit and rapid mobile friction remediation for Shopify merchants.",
  aliases: ["shopify-profile", "storefront-optimization", "shopify-optimization"],
  persona: "a specialist in Shopify storefront conversion hygiene",
  idealCustomers: [
    "Shopify merchants doing roughly $1M-$5M in annual revenue",
    "Stores with meaningful mobile traffic and checkout friction",
    "Owners who already invest in paid traffic and care about conversion"
  ],
  painPoints: [
    "High mobile checkout friction and drop-off",
    "Inconsistent or outdated Google listing hours",
    "Paying for traffic that does not convert"
  ],
  benefits: [
    "Faster, lower-friction mobile checkout path",
    "Verified storefront hygiene fixes with visual evidence",
    "Measured hygiene outcomes rather than unverifiable promises"
  ],
  qualificationRules: [
    "Only pursue merchants on Shopify (or Shopify Plus)",
    "Do not sell when the store is inactive or pre-launch",
    "Do not promise revenue outcomes to qualify a deal"
  ],
  discoveryQuestions: [
    "What share of your traffic is mobile today?",
    "Where do you see the biggest drop-off in the checkout flow?",
    "Have your Google listing hours been updated since your last change?"
  ],
  objections: [
    { objection: "too expensive", response: "Pricing is firmly set at $400 for the pilot and $900 monthly; we do not discount." },
    { objection: "will this increase revenue?", response: "We do not guarantee revenue. The pilot executes storefront hygiene and measures the hygiene outcomes." },
    { objection: "can you also run my ads?", response: "Paid ads and email marketing are outside the pilot scope; the pilot is limited to storefront conversion hygiene." }
  ],
  buyingSignals: [
    "Prospect asks about timeline or kickoff",
    "Prospect asks who performs the work",
    "Prospect references a specific checkout problem they want fixed"
  ],
  ctas: [
    "Offer to run the storefront hygiene audit this week",
    "Propose a 20-minute review of the audit findings"
  ],
  offer: {
    pilotPrice: 400,
    monthlyPrice: 900,
    currency: "USD",
    scope: "Storefront conversion hygiene testing and mobile friction remediation.",
    deliverables: [
      "Storefront conversion hygiene audit",
      "Mobile checkout friction remediation",
      "Google listing hours verification"
    ]
  },
  businessConstraints: {
    authorizedPrices: [400, 900],
    disallowDiscounts: true,
    prohibitedClaims: ["guarantee", "guaranteed revenue"],
    prohibitedTopics: ["paid ads", "email marketing", "store rebuild"]
  },
  tools: [
    { name: "getProspect", description: "Get the prospect store profile (name, industry, platform, revenue band, reviews).", data: { name: "Example Fashion Store", industry: "Fashion", platform: "Shopify", revenueBand: "$1M-$5M", googleReviews: 312, googleRating: 4.7 } },
    { name: "getAudit", description: "Get the main storefront audit finding.", data: { finding: "Missing express checkout options on mobile." } },
    { name: "getEvidence", description: "Get visual evidence items for the storefront.", data: [ { id: "audit-screenshot-01", type: "outdated_listing" }, { id: "audit-screenshot-02", type: "conversion_friction" } ] },
    { name: "getOffer", description: "Get pilot and monthly pricing plus pilot scope.", data: { pilotPrice: 400, monthlyPrice: 900, scope: "Storefront conversion hygiene testing." } }
  ],
  context: { service: "shopify-storefront-optimization" }
};
