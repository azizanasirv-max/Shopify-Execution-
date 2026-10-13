/**
 * Service Adapter Architecture + Master Sales Template validation suite.
 *
 * Fully deterministic and offline. Verifies:
 * 1. Profile validation: required fields and price/constraint coherence.
 * 2. Master template is service-agnostic (no service assumptions in the core).
 * 3. Adapter isolation: profiles produce distinct instructions/tools/policies.
 * 4. Service switching via AdapterRegistry (ids + aliases).
 * 5. Objection handling and prohibited-claim enforcement.
 * 6. Per-service pricing isolation through the approval gate.
 * 7. Regression safety with the existing engine/approval gate.
 */

import { GenericSalesEngine } from "../engine/generic-sales-engine.js";
import { AdapterRegistry, UnknownProductError } from "../engine/adapter-registry.js";
import {
  validateServiceProfile,
  assertValidServiceProfile,
  ServiceProfileValidationError,
  ServiceProfile
} from "../engine/service-profile.js";
import { MasterSalesTemplate } from "../engine/master-sales-template.js";
import { ProfileBackedSalesAdapter } from "../engine/profile-adapter.js";
import {
  SHOPIFY_SERVICE_PROFILE,
  GHOSTWRITER_SERVICE_PROFILE,
  CLIPPING_SERVICE_PROFILE,
  ALL_SERVICE_PROFILES,
  registerServiceProfiles
} from "../sales-api/profiles/index.js";
import { ModelProvider, SAFE_FALLBACK_RECOMMENDATION } from "../engine/types.js";

class CannedModelProvider implements ModelProvider {
  public callCount = 0;
  constructor(private responses: Array<{ text?: string; error?: Error }>) {}
  async generateContent() {
    this.callCount++;
    const next = this.responses.shift();
    if (!next) return { text: "Default mock response" };
    if (next.error) throw next.error;
    return { text: next.text };
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export async function runServiceProfileTests(): Promise<{ passed: number; failed: number; total: number }> {
  console.log("==================================================");
  console.log("   RUNNING SERVICE ADAPTER / MASTER TEMPLATE SUITE  ");
  console.log("==================================================");

  let passed = 0;
  let failed = 0;
  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName}${detail ? ` -> ${detail}` : ""}`);
      failed++;
    }
  }

  const template = new MasterSalesTemplate();

  // -----------------------------------------------------------------
  // 1. Profile validation
  // -----------------------------------------------------------------
  console.log("\n[1] Service profile validation...");
  assert(ALL_SERVICE_PROFILES.length === 3, "Three representative profiles are provided (shopify, ghostwriter, clipping)");
  for (const profile of ALL_SERVICE_PROFILES) {
    const errors = validateServiceProfile(profile);
    assert(errors.length === 0, `Profile '${profile.id}' passes required-field validation`, errors.join("; "));
  }

  const missingBenefits = clone(SHOPIFY_SERVICE_PROFILE) as any;
  delete missingBenefits.benefits;
  assert(validateServiceProfile(missingBenefits).some((e) => e.includes("benefits")), "Missing required field is reported");

  const badPrice = clone(SHOPIFY_SERVICE_PROFILE) as any;
  badPrice.offer.pilotPrice = 999;
  assert(validateServiceProfile(badPrice).some((e) => e.includes("pilotPrice")), "Offer price outside authorizedPrices is rejected");

  const dupTools = clone(SHOPIFY_SERVICE_PROFILE) as any;
  dupTools.tools[1].name = dupTools.tools[0].name;
  assert(validateServiceProfile(dupTools).some((e) => e.includes("duplicated")), "Duplicate tool names are rejected");

  const emptyObjections = clone(SHOPIFY_SERVICE_PROFILE) as any;
  emptyObjections.objections = [];
  assert(validateServiceProfile(emptyObjections).some((e) => e.includes("objections")), "Empty objections are rejected");

  let validationError: any = null;
  try {
    assertValidServiceProfile(missingBenefits);
  } catch (e) {
    validationError = e;
  }
  assert(validationError instanceof ServiceProfileValidationError && validationError.code === "INVALID_SERVICE_PROFILE", "assertValidServiceProfile fails closed with a typed error");

  let ctorError: any = null;
  try {
    new ProfileBackedSalesAdapter(badPrice);
  } catch (e) {
    ctorError = e;
  }
  assert(ctorError instanceof ServiceProfileValidationError, "ProfileBackedSalesAdapter rejects an invalid profile at construction");

  // -----------------------------------------------------------------
  // 2. Master template is service-agnostic
  // -----------------------------------------------------------------
  console.log("\n[2] Master template service-agnosticism...");
  const methodology = template.methodology.toLowerCase();
  const forbidden = ["shopify", "ghostwrit", "clip", "$400", "$900", "$600", "$1500", "$1200", "$2500", "storefront", "podcast"];
  assert(forbidden.every((t) => !methodology.includes(t)), "Shared methodology contains no service-specific assumptions");

  const shopifyAdapter = new ProfileBackedSalesAdapter(SHOPIFY_SERVICE_PROFILE, template);
  const ghostwriterAdapter = new ProfileBackedSalesAdapter(GHOSTWRITER_SERVICE_PROFILE, template);
  const clippingAdapter = new ProfileBackedSalesAdapter(CLIPPING_SERVICE_PROFILE, template);

  const shopifyInstr = shopifyAdapter.getSystemInstructions();
  const ghostInstr = ghostwriterAdapter.getSystemInstructions();
  const clipInstr = clippingAdapter.getSystemInstructions();
  assert(shopifyInstr.startsWith(template.methodology), "Rendered instruction begins with the shared methodology");
  assert(ghostInstr.startsWith(template.methodology) && clipInstr.startsWith(template.methodology), "All rendered instructions share the same methodology header");
  assert(shopifyInstr !== ghostInstr && ghostInstr !== clipInstr && shopifyInstr !== clipInstr, "Service blocks differ per profile (no duplication of core)");
  assert(shopifyInstr.includes(SHOPIFY_SERVICE_PROFILE.name) && clipInstr.includes(CLIPPING_SERVICE_PROFILE.name), "Each rendered instruction carries its own service name");

  // -----------------------------------------------------------------
  // 3. Adapter isolation
  // -----------------------------------------------------------------
  console.log("\n[3] Adapter isolation...");
  assert(new Set([shopifyAdapter.id, ghostwriterAdapter.id, clippingAdapter.id]).size === 3, "Profile adapters have distinct canonical ids");
  const shopifyTools = shopifyAdapter.getTools().map((t) => t.name);
  const clipTools = clippingAdapter.getTools().map((t) => t.name);
  assert(shopifyTools.includes("getOffer") && !clipTools.includes("getOffer"), "Tool sets are isolated per service");
  assert(clipTools.includes("getClippingOffer") && !shopifyTools.includes("getClippingOffer"), "Clipping tools do not leak into other services");

  const offerFromShopify = await shopifyAdapter.executeTool("getOffer");
  assert(offerFromShopify.pilotPrice === 400, "Shopify profile returns its own offer data");
  let crossToolError: any = null;
  try {
    await shopifyAdapter.executeTool("getClippingOffer");
  } catch (e) {
    crossToolError = e;
  }
  assert(crossToolError !== null, "Cross-service tool execution is rejected (fail closed)");

  const shopifyPolicies = shopifyAdapter.getBehavioralPolicies().map((p) => p.id);
  const clipPolicies = clippingAdapter.getBehavioralPolicies().map((p) => p.id);
  assert(shopifyPolicies.includes("no-discounts") && clipPolicies.includes("no-discounts"), "Discount policy derived from each profile's constraints");
  assert(shopifyPolicies.includes("scope-boundaries") && clipPolicies.includes("scope-boundaries"), "Scope boundaries derived from each profile's constraints");

  // -----------------------------------------------------------------
  // 4. Service switching via the registry
  // -----------------------------------------------------------------
  console.log("\n[4] Service switching via AdapterRegistry...");
  const registry = new AdapterRegistry();
  const registered = registerServiceProfiles(registry);
  assert(registered.length === 3, "registerServiceProfiles registers all profiles");
  assert(registry.resolve("clipping-service-profile").id === "clipping-service-profile", "Resolve by canonical id");
  assert(registry.resolve("clips").id === "clipping-service-profile", "Resolve clipping by alias");
  assert(registry.resolve("shopify-profile").id === "shopify-service-profile", "Resolve shopify profile by alias");
  assert(registry.resolve("thought-leadership").id === "ghostwriter-service-profile", "Resolve ghostwriter profile by alias");
  let unknownError: any = null;
  try {
    registry.resolve("not-a-service");
  } catch (e) {
    unknownError = e;
  }
  assert(unknownError instanceof UnknownProductError, "Unknown service fails closed");
  assert(registry.getSummaries().length === 3, "Registry exposes three service summaries");

  // -----------------------------------------------------------------
  // 5. Objection handling + prohibited claims
  // -----------------------------------------------------------------
  console.log("\n[5] Objection handling and prohibited claims...");
  assert(clipInstr.includes("will the clips go viral"), "Objection playbook is rendered into the instruction");
  assert(clipInstr.includes("We do not guarantee views or virality"), "Compliant objection response is rendered");
  const clipGuarantee = clippingAdapter.validateResponse("We guarantee 1 million views for every clip.", "Will this go viral?");
  assert(clipGuarantee.isGrounded === false, "Guarantee claim is rejected by the profile validator");
  const clipRefusal = clippingAdapter.validateResponse("We do not guarantee views or virality.", "Will this go viral?");
  assert(clipRefusal.isGrounded === true, "A compliant refusal of a guarantee passes validation");
  const clipOutOfScope = clippingAdapter.validateResponse("We can also handle your full video editing.", "Can you edit episodes?");
  assert(clipOutOfScope.isGrounded === false, "Out-of-scope topic is rejected");

  // -----------------------------------------------------------------
  // 6. Per-service pricing isolation through the approval gate
  // -----------------------------------------------------------------
  console.log("\n[6] Per-service pricing isolation...");
  const clipEngine = new GenericSalesEngine({
    modelProvider: new CannedModelProvider([{ text: "Our pilot is $600 and the monthly plan is $1,500." }]),
    defaultAdapter: clippingAdapter
  });
  const clipApproved = await clipEngine.generateRecommendation("What is the price?");
  assert(clipApproved.status === "APPROVED", "Clipping prices pass the clipping approval gate");

  const clipWrongPriceEngine = new GenericSalesEngine({
    modelProvider: new CannedModelProvider([{ text: "Our pilot is $400." }, { text: "Our pilot is $400." }]),
    defaultAdapter: clippingAdapter
  });
  const clipWrongPrice = await clipWrongPriceEngine.generateRecommendation("What is the price?");
  assert(clipWrongPrice.status === "BLOCKED", "A price from another service is blocked for clipping");
  assert(clipWrongPrice.statement === SAFE_FALLBACK_RECOMMENDATION, "Blocked cross-service price never leaks");

  // -----------------------------------------------------------------
  // 7. Regression safety with the engine
  // -----------------------------------------------------------------
  console.log("\n[7] Regression safety...");
  const shopifyEngine = new GenericSalesEngine({
    modelProvider: new CannedModelProvider([{ text: "Our pilot is $400 and the monthly plan is $900." }]),
    defaultAdapter: shopifyAdapter
  });
  const shopifyRec = await shopifyEngine.generateRecommendation("What is the price?");
  assert(shopifyRec.status === "APPROVED", "Shopify profile recommendation is approved through the existing gate");
  assert(shopifyRec.engineMetadata.productId === "shopify-service-profile", "Recommendation is bound to the active profile id");

  const switchEngine = new GenericSalesEngine({
    modelProvider: new CannedModelProvider([{ text: "Our pilot is $400 and the monthly plan is $900." }, { text: "Our pilot is $600 and the monthly plan is $1,500." }]),
    defaultAdapter: shopifyAdapter,
    adapterRegistry: registry
  });
  const recA = await switchEngine.generateRecommendation("What is the price?", { productId: "shopify-profile" });
  const recB = await switchEngine.generateRecommendation("What is the price?", { productId: "clips" });
  assert(recA.status === "APPROVED" && recA.engineMetadata.productId === "shopify-service-profile", "Service switch to shopify profile resolves correctly");
  assert(recB.status === "APPROVED" && recB.engineMetadata.productId === "clipping-service-profile", "Service switch to clipping profile resolves correctly");

  console.log("\n--------------------------------------------------");
  console.log(`Service Profile Tests Summary: Passed: ${passed}, Failed: ${failed}, Total: ${passed + failed}`);
  console.log("==================================================");
  return { passed, failed, total: passed + failed };
}

if (process.argv[1] && process.argv[1].endsWith("service-profile-tests.ts")) {
  runServiceProfileTests().then((summary) => {
    process.exit(summary.failed === 0 ? 0 : 1);
  });
}
