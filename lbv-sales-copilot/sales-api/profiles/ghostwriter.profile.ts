/**
 * Representative service profile: Executive ghostwriting / thought leadership.
 * Data-only; no methodology logic.
 */

import { ServiceProfile } from "../../engine/service-profile.js";

export const GHOSTWRITER_SERVICE_PROFILE: ServiceProfile = {
  id: "ghostwriter-service-profile",
  name: "Ghostwriter Executive Thought Leadership",
  description: "High-touch executive ghostwriting and personal brand authority for founders and tech leaders.",
  aliases: ["ghostwriter-profile", "thought-leadership", "executive-ghostwriting"],
  persona: "a specialist in executive ghostwriting and thought leadership",
  idealCustomers: [
    "Founders, CTOs, and executives with strong domain insight",
    "Leaders who want authority with enterprise buyers and investors",
    "Operators with irregular publishing cadence"
  ],
  painPoints: [
    "Insight is not reaching the right audience",
    "Technical jargon without narrative hooks",
    "No consistent publishing cadence"
  ],
  benefits: [
    "High-fidelity executive writing in the leader's voice",
    "A reliable, consistent publishing cadence",
    "Narrative structure that earns attention"
  ],
  qualificationRules: [
    "Only pursue executives with genuine domain expertise",
    "Do not promise audience growth or lead counts",
    "Do not accept work requiring video production or PR outreach"
  ],
  discoveryQuestions: [
    "Who are you trying to reach with your writing?",
    "What cadence could you realistically sustain for a voice interview?",
    "Which recent piece best reflects your point of view?"
  ],
  objections: [
    { objection: "will this make me go viral?", response: "We do not guarantee virality or follower growth. We guarantee high-fidelity writing and a consistent cadence." },
    { objection: "too expensive", response: "The pilot is $1,200 and the retainer is $2,500 monthly; pricing is firm with no discounts." },
    { objection: "can you also produce video?", response: "Video production is outside scope; the pilot covers long-form written essays." }
  ],
  buyingSignals: [
    "Prospect asks about the voice interview process",
    "Prospect shares a recent piece they want to emulate",
    "Prospect asks when the first essay would publish"
  ],
  ctas: [
    "Offer to schedule the 60-minute voice discovery interview",
    "Propose publishing the first essay within two weeks"
  ],
  offer: {
    pilotPrice: 1200,
    monthlyPrice: 2500,
    currency: "USD",
    scope: "Four long-form executive essays with a voice interview and two revision cycles.",
    deliverables: [
      "Four long-form executive essays",
      "60-minute voice discovery interview",
      "Two revision cycles per essay"
    ]
  },
  businessConstraints: {
    authorizedPrices: [1200, 2500],
    disallowDiscounts: true,
    prohibitedClaims: ["guarantee", "guaranteed followers"],
    prohibitedTopics: ["video production", "pr outreach"]
  },
  tools: [
    { name: "getExecutiveProfile", description: "Get the prospective executive author's profile and audience.", data: { clientName: "SaaS Founder / CTO", targetAudience: "Enterprise Buyers & Investors", primaryPlatform: "LinkedIn & Substack" } },
    { name: "getEditorialAudit", description: "Get the editorial audit of the prospect's current content.", data: { finding: "Strong domain insight but low engagement due to jargon and weak narrative hooks." } },
    { name: "getWritingSamples", description: "Get verified writing samples and engagement metrics.", data: [ { id: "sample-essay-01", impressions: "45,000 views, 340 shares" }, { id: "sample-essay-02", impressions: "28,000 views, 190 shares" } ] },
    { name: "getGhostwriterOffer", description: "Get pilot and retainer pricing plus editorial scope.", data: { pilotPrice: 1200, monthlyPrice: 2500, scope: "4 long-form essays with voice interview." } }
  ],
  context: { service: "executive-ghostwriting" }
};
