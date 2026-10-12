/**
 * Representative service profile: Short-form content clipping.
 * Data-only; no methodology logic.
 */

import { ServiceProfile } from "../../engine/service-profile.js";

export const CLIPPING_SERVICE_PROFILE: ServiceProfile = {
  id: "clipping-service-profile",
  name: "Short-Form Content Clipping",
  description: "Turns long-form podcasts and webinars into a steady stream of short-form clips for founders and creators.",
  aliases: ["clipping", "short-form-clipping", "content-clipping", "clips"],
  persona: "a specialist in short-form content clipping and repurposing",
  idealCustomers: [
    "Podcasters and webinar hosts with existing long-form libraries",
    "Founders and creators who want consistent short-form presence",
    "Teams without an in-house editor for repurposing"
  ],
  painPoints: [
    "Long-form content sits unused after publishing",
    "Inconsistent short-form posting across platforms",
    "Editing capacity is the bottleneck"
  ],
  benefits: [
    "A predictable pipeline of short-form clips",
    "Platform-ready captions and formatting",
    "Consistent posting without hiring an editor"
  ],
  qualificationRules: [
    "Only pursue prospects who already have long-form source content",
    "Do not promise view counts or follower growth",
    "Do not accept full-length video editing engagements"
  ],
  discoveryQuestions: [
    "How many long-form episodes or webinars do you have already recorded?",
    "Which platforms matter most for your short-form presence?",
    "Who edits and posts clips today, and how long does it take?"
  ],
  objections: [
    { objection: "will the clips go viral?", response: "We do not guarantee views or virality. We guarantee a consistent pipeline of platform-ready clips." },
    { objection: "too expensive", response: "The pilot is $600 and the monthly plan is $1,500; pricing is firm with no discounts." },
    { objection: "can you edit our full episodes too?", response: "Full-length video editing is outside scope; we focus on short-form clipping from existing sources." }
  ],
  buyingSignals: [
    "Prospect asks how many clips per month they would get",
    "Prospect shares a link to their existing library",
    "Prospect asks about turnaround time"
  ],
  ctas: [
    "Offer to produce a sample batch of clips from one episode",
    "Propose a 15-minute review of a sample clip set"
  ],
  offer: {
    pilotPrice: 600,
    monthlyPrice: 1500,
    currency: "USD",
    scope: "Short-form clip production from existing long-form content.",
    deliverables: [
      "A batch of short-form clips from one source episode",
      "Platform-ready captions and formatting",
      "A repeatable monthly clip pipeline"
    ]
  },
  businessConstraints: {
    authorizedPrices: [600, 1500],
    disallowDiscounts: true,
    prohibitedClaims: ["guarantee", "guaranteed views"],
    prohibitedTopics: ["full video editing", "paid ad spend"]
  },
  tools: [
    { name: "getCreatorProfile", description: "Get the creator's profile and existing content library.", data: { creator: "B2B Podcast Host", library: "120 episodes", platforms: "YouTube Shorts, TikTok, LinkedIn" } },
    { name: "getContentAudit", description: "Get the audit of the creator's current short-form output.", data: { finding: "Only 3 clips posted in the last 60 days despite weekly episodes." } },
    { name: "getClipSamples", description: "Get verified sample clips and engagement metrics.", data: [ { id: "clip-sample-01", metric: "12,400 views" }, { id: "clip-sample-02", metric: "8,900 views" } ] },
    { name: "getClippingOffer", description: "Get pilot and monthly pricing plus clipping scope.", data: { pilotPrice: 600, monthlyPrice: 1500, scope: "Short-form clip production from existing long-form content." } }
  ],
  context: { service: "short-form-clipping" }
};
