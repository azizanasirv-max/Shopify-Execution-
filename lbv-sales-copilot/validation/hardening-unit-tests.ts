/**
 * Automated Unit Test Suite for Hardened LBV Sales Engine
 *
 * Verifies:
 * 1. Runtime Tool Argument Schema Validation (Fail-closed schema validator)
 *    - Valid arguments against parameter schemas
 *    - Wrong argument types (string, number, boolean, array, object)
 *    - Missing required properties
 *    - Unexpected properties when disallowed
 *    - Unknown tool names rejected before execution
 *    - Malformed arguments (non-objects, arrays)
 *    - Tools with no arguments handled consistently and securely
 *
 * 2. Centralized Commercial Commitment Validation
 *    - Detection of unauthorized prices independently of revenue keywords
 *    - Preserving authorized prices ($400 pilot, $900 monthly)
 *    - Preserving allowed revenue bands ($1M-$5M)
 *    - Distinguishing legitimate prompt corrections from active commitments
 *    - Catching wording bypasses ("$250 pilot", "$250 rebate", "$300 rate", "I can do $250")
 *    - Preserving positive controls
 *
 * 3. Product Independence & Adapter Isolation
 *    - Authoritative offer data isolation between Shopify and Ghostwriter
 *    - Rejection of another adapter's tools
 */

import { validateToolCall, SchemaValidationResult } from "../engine/schema-validator.js";
import { validateCommercialCommitments } from "../engine/commercial-validator.js";
import { ToolDefinition } from "../engine/types.js";
import { ShopifySalesAdapter } from "../sales-api/shopify-adapter.js";
import { GhostwriterSalesAdapter } from "../sales-api/ghostwriter-adapter.js";

export async function runHardeningUnitTests(): Promise<{ passed: number; failed: number; total: number }> {
  console.log("==================================================");
  console.log("     RUNNING SALES ENGINE HARDENING UNIT TESTS    ");
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

  // -------------------------------------------------------------
  // TEST SUITE 1: RUNTIME TOOL ARGUMENT SCHEMA VALIDATION
  // -------------------------------------------------------------
  console.log("\n--- SUITE 1: Runtime Tool Argument Schema Validation ---");

  // Sample tool definitions
  const noArgsTool: ToolDefinition = {
    name: "getOffer",
    description: "Get offer details with no parameters",
    parameters: {
      type: "OBJECT",
      properties: {}
    }
  };

  const parameterizedTool: ToolDefinition = {
    name: "queryMetrics",
    description: "Query specific metric with type and range",
    parameters: {
      type: "OBJECT",
      properties: {
        metricName: { type: "string" },
        daysCount: { type: "integer" },
        includeBreakdown: { type: "boolean" },
        category: { type: "string", enum: ["performance", "inventory", "listing"] }
      },
      required: ["metricName", "daysCount"]
    }
  };

  // 1.1 Tool with no arguments - Valid empty object
  const resNoArgsEmpty = validateToolCall(noArgsTool, {});
  assert(resNoArgsEmpty.valid, "Tool with no arguments accepts empty object {}");

  // 1.2 Tool with no arguments - Valid undefined/null
  const resNoArgsUndef = validateToolCall(noArgsTool, undefined);
  assert(resNoArgsUndef.valid, "Tool with no arguments accepts undefined");
  const resNoArgsNull = validateToolCall(noArgsTool, null);
  assert(resNoArgsNull.valid, "Tool with no arguments accepts null");

  // 1.3 Tool with no arguments - Rejects unexpected parameters
  const resNoArgsExtra = validateToolCall(noArgsTool, { unexpectedField: "value" });
  assert(!resNoArgsExtra.valid, "Tool with no arguments rejects unexpected fields", resNoArgsExtra.error);

  // 1.4 Tool with no arguments - Rejects malformed arguments (primitive/array)
  const resNoArgsString = validateToolCall(noArgsTool, "invalid-string");
  assert(!resNoArgsString.valid, "Tool with no arguments rejects string primitive", resNoArgsString.error);
  const resNoArgsArray = validateToolCall(noArgsTool, ["param"]);
  assert(!resNoArgsArray.valid, "Tool with no arguments rejects array", resNoArgsArray.error);
  const resNoArgsNumber = validateToolCall(noArgsTool, 42);
  assert(!resNoArgsNumber.valid, "Tool with no arguments rejects number primitive", resNoArgsNumber.error);

  // 1.5 Unknown tool name - Rejects unknown tool before execution
  const resUnknownTool = validateToolCall(undefined, { foo: "bar" });
  assert(!resUnknownTool.valid, "Rejects unknown/undeclared tool definition", resUnknownTool.error);

  // 1.6 Parameterized tool - Valid arguments
  const resParamValid = validateToolCall(parameterizedTool, {
    metricName: "page-speed",
    daysCount: 30,
    includeBreakdown: true,
    category: "performance"
  });
  assert(resParamValid.valid, "Parameterized tool accepts valid arguments with all fields");

  // 1.7 Parameterized tool - Valid with only required arguments
  const resParamRequiredOnly = validateToolCall(parameterizedTool, {
    metricName: "page-speed",
    daysCount: 7
  });
  assert(resParamRequiredOnly.valid, "Parameterized tool accepts valid arguments with required fields only");

  // 1.8 Parameterized tool - Missing required property
  const resParamMissingReq = validateToolCall(parameterizedTool, {
    metricName: "page-speed"
    // missing daysCount
  });
  assert(!resParamMissingReq.valid, "Parameterized tool rejects missing required property", resParamMissingReq.error);

  // 1.9 Parameterized tool - Wrong type: string instead of integer
  const resParamWrongTypeNum = validateToolCall(parameterizedTool, {
    metricName: "page-speed",
    daysCount: "thirty" // should be integer
  });
  assert(!resParamWrongTypeNum.valid, "Parameterized tool rejects string for integer parameter", resParamWrongTypeNum.error);

  // 1.10 Parameterized tool - Wrong type: number instead of boolean
  const resParamWrongTypeBool = validateToolCall(parameterizedTool, {
    metricName: "page-speed",
    daysCount: 14,
    includeBreakdown: 1 // should be boolean
  });
  assert(!resParamWrongTypeBool.valid, "Parameterized tool rejects number for boolean parameter", resParamWrongTypeBool.error);

  // 1.11 Parameterized tool - Invalid enum value
  const resParamInvalidEnum = validateToolCall(parameterizedTool, {
    metricName: "page-speed",
    daysCount: 14,
    category: "forbidden-category"
  });
  assert(!resParamInvalidEnum.valid, "Parameterized tool rejects invalid enum value", resParamInvalidEnum.error);

  // 1.12 Parameterized tool - Unexpected extra property
  const resParamExtraProp = validateToolCall(parameterizedTool, {
    metricName: "page-speed",
    daysCount: 14,
    unauthorizedInjectedField: "malicious"
  });
  assert(!resParamExtraProp.valid, "Parameterized tool rejects unexpected extra properties", resParamExtraProp.error);

  // 1.13 Parameterized tool - Malformed non-object inputs
  const resParamMalformedString = validateToolCall(parameterizedTool, "not-an-object");
  assert(!resParamMalformedString.valid, "Parameterized tool rejects non-object string input", resParamMalformedString.error);
  const resParamMalformedArray = validateToolCall(parameterizedTool, [1, 2, 3]);
  assert(!resParamMalformedArray.valid, "Parameterized tool rejects array input", resParamMalformedArray.error);


  // -------------------------------------------------------------
  // TEST SUITE 2: CENTRALIZED COMMERCIAL COMMITMENT VALIDATION
  // -------------------------------------------------------------
  console.log("\n--- SUITE 2: Centralized Commercial Commitment Validation ---");

  const shopifyConfig = {
    authorizedPrices: [400, 900],
    allowedBands: ["$1M", "$5M", "$1m", "$5m"],
    disallowDiscounts: true
  };

  // 2.1 Authorized prices approved
  const resAuthPrices = validateCommercialCommitments(
    "The pilot price is $400, and our ongoing monthly plan is $900.",
    "What are your prices?",
    shopifyConfig
  );
  assert(resAuthPrices.valid, "Approves legitimate authorized prices ($400, $900)");

  // 2.2 Allowed revenue bands approved
  const resAllowedBands = validateCommercialCommitments(
    "We observe your store operates in the public $1M-$5M annual revenue band.",
    "What is our revenue?",
    shopifyConfig
  );
  assert(resAllowedBands.valid, "Approves prospect annual revenue bands ($1M-$5M)");

  // 2.3 Rejection of unauthorized prompt amount approved
  const resCorrection200 = validateCommercialCommitments(
    "That is incorrect. The pilot price is firmly set at $400, not $200.",
    "I heard your pilot is only $200.",
    shopifyConfig
  );
  assert(resCorrection200.valid, "Approves legitimate prompt price correction ('not $200')");

  const resCorrection100 = validateCommercialCommitments(
    "We cannot do the pilot for $100. Our pricing is firmly $400.",
    "Can you do it for $100?",
    shopifyConfig
  );
  assert(resCorrection100.valid, "Approves rejection of prompt offer ('cannot do it for $100')");

  const resCorrection500 = validateCommercialCommitments(
    "The monthly recurring price is $900, not $500.",
    "Is the monthly plan $500?",
    shopifyConfig
  );
  assert(resCorrection500.valid, "Approves correction of monthly price ('not $500')");

  // 2.4 UNAUTHORIZED PRICING COMMITMENTS DETECTED (Fixing wording bypasses)
  const resBypass250Pilot = validateCommercialCommitments(
    "You can pay $250 for the pilot.",
    "Can I get a deal?",
    shopifyConfig
  );
  assert(!resBypass250Pilot.valid, "Catches '$250 for the pilot' bypass without revenue keywords");

  const resBypass250Rebate = validateCommercialCommitments(
    "I'll give you a $250 rebate.",
    "Can I get a discount?",
    shopifyConfig
  );
  assert(!resBypass250Rebate.valid, "Catches '$250 rebate' unauthorized commitment");

  const resBypass300Rate = validateCommercialCommitments(
    "I can offer a special $300 rate.",
    "What is your best price?",
    shopifyConfig
  );
  assert(!resBypass300Rate.valid, "Catches '$300 rate' unauthorized rate commitment");

  const resBypass250Direct = validateCommercialCommitments(
    "I can do $250.",
    "Can you do $250?",
    shopifyConfig
  );
  assert(!resBypass250Direct.valid, "Catches 'I can do $250' unauthorized commitment");

  const resBypassDiscount50 = validateCommercialCommitments(
    "I can offer a 50% discount on the pilot.",
    "Give me 50% off",
    shopifyConfig
  );
  assert(!resBypassDiscount50.valid, "Catches unauthorized 50% discount commitment");

  // 2.5 Rejection of discount approved
  const resRejectionDiscount = validateCommercialCommitments(
    "We do not offer discounts, custom rates, or rebates. Pricing is firmly set at $400.",
    "Give me 50% off",
    shopifyConfig
  );
  assert(resRejectionDiscount.valid, "Approves legitimate policy rejection of discounts");


  // -------------------------------------------------------------
  // TEST SUITE 3: PRODUCT INDEPENDENCE & ADAPTER BOUNDARIES
  // -------------------------------------------------------------
  console.log("\n--- SUITE 3: Product Independence & Adapter Isolation ---");

  const shopifyAdapter = new ShopifySalesAdapter();
  const ghostwriterAdapter = new GhostwriterSalesAdapter();

  // 3.1 Shopify tools exist and include getOffer
  const shopifyTools = shopifyAdapter.getTools();
  assert(shopifyTools.some(t => t.name === "getOffer"), "Shopify adapter exposes getOffer tool");
  assert(shopifyTools.some(t => t.name === "getAudit"), "Shopify adapter exposes getAudit tool");

  // 3.2 Ghostwriter tools are distinct
  const ghostwriterTools = ghostwriterAdapter.getTools();
  assert(ghostwriterTools.some(t => t.name === "getEditorialAudit"), "Ghostwriter exposes getEditorialAudit");
  assert(!ghostwriterTools.some(t => t.name === "getAudit"), "Ghostwriter does not expose Shopify getAudit tool");

  // 3.3 Ghostwriter rejects Shopify tools
  let ghostwriterRejectionPass = false;
  try {
    // Attempting to execute Shopify tool on Ghostwriter adapter must reject
    await ghostwriterAdapter.executeTool("getProspect");
  } catch (err: any) {
    ghostwriterRejectionPass = true;
  }
  assert(ghostwriterRejectionPass, "Ghostwriter adapter rejects Shopify getProspect execution");

  // 3.4 Ghostwriter uses distinct high-ticket pricing ($1500 discovery, $4500 retainer)
  const gwConfig = {
    authorizedPrices: [1500, 4500],
    disallowDiscounts: true
  };
  const resGwAuth = validateCommercialCommitments(
    "Our executive discovery sprint is $1,500, and our thought leadership retainer is $4,500 monthly.",
    "What are your rates?",
    gwConfig
  );
  assert(resGwAuth.valid, "Ghostwriter approves its own distinct authoritative prices ($1500, $4500)");

  // 3.5 Shopify price ($400) would be unauthorized in Ghostwriter
  const resGwRejectShopifyPrice = validateCommercialCommitments(
    "I can do the engagement for $400.",
    "Can you do it cheaper?",
    gwConfig
  );
  assert(!resGwRejectShopifyPrice.valid, "Ghostwriter rejects Shopify $400 price as unauthorized");

  console.log("\n--------------------------------------------------");
  console.log(`Hardening Unit Tests Summary: Successes: ${passed} | Failures: ${failed} | Total: ${passed + failed}`);
  console.log("==================================================");

  return { passed, failed, total: passed + failed };
}
