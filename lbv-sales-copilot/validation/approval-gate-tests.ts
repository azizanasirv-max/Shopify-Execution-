/**
 * Deterministic Test Suite for Enforced Approval Gate in Generic Sales Engine
 *
 * Fully tests all 12 approval gate and bounded recovery requirements without
 * depending on external network calls or Gemini API quota.
 *
 * Requirements verified:
 * 1. A valid Shopify response is approved.
 * 2. An invalid Shopify response is blocked or recovered.
 * 3. A valid Ghostwriter response is approved.
 * 4. An invalid Ghostwriter response is blocked or recovered.
 * 5. A response with an unauthorized price is not approved.
 * 6. A response inventing a financial guarantee is not approved.
 * 7. A response with fabricated evidence is not approved when the adapter's validator detects it.
 * 8. A disclaimer does not override a detected violation.
 * 9. A failed recovery cannot accidentally return the rejected response as approved.
 * 10. Model-provider errors do not become approved recommendations.
 * 11. Validation metadata accurately reflects the final returned result.
 * 12. Existing tool execution restrictions remain intact.
 */

import { GenericSalesEngine } from "../engine/generic-sales-engine.js";
import {
  ModelProvider,
  SAFE_FALLBACK_RECOMMENDATION,
  SalesApiAdapter
} from "../engine/types.js";
import { ShopifySalesAdapter } from "../sales-api/shopify-adapter.js";
import { GhostwriterSalesAdapter } from "../sales-api/ghostwriter-adapter.js";

/**
 * Deterministic Mock Model Provider for simulated multi-turn conversations
 */
export class MockModelProvider implements ModelProvider {
  private turnQueue: Array<{
    text?: string;
    functionCalls?: any[];
    error?: Error;
  }>;
  public callCount = 0;
  public recordedPrompts: any[] = [];

  constructor(responses: Array<{ text?: string; functionCalls?: any[]; error?: Error }>) {
    this.turnQueue = [...responses];
  }

  async generateContent(params: { model: string; contents: any[]; config?: any }) {
    this.callCount++;
    this.recordedPrompts.push(params.contents);
    const next = this.turnQueue.shift();
    if (!next) {
      return { text: "Default mock response" };
    }
    if (next.error) {
      throw next.error;
    }
    return {
      text: next.text,
      functionCalls: next.functionCalls
    };
  }
}

export async function runApprovalGateUnitTests(): Promise<{ passed: number; failed: number; total: number }> {
  console.log("==================================================");
  console.log("    RUNNING ENFORCED APPROVAL GATE TEST SUITE     ");
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

  const shopifyAdapter = new ShopifySalesAdapter();
  const ghostwriterAdapter = new GhostwriterSalesAdapter();

  // -------------------------------------------------------------
  // TEST 1: A valid Shopify response is approved
  // -------------------------------------------------------------
  console.log("\n[1/12] Testing valid Shopify response approval...");
  const validShopifyText = "Our pilot price is exactly $400, and our monthly ongoing plan is $900.";
  const mock1 = new MockModelProvider([{ text: validShopifyText }]);
  const engine1 = new GenericSalesEngine({
    modelProvider: mock1,
    defaultAdapter: shopifyAdapter
  });
  const res1 = await engine1.generateRecommendation("What are your rates?");
  assert(res1.status === "APPROVED", "Valid Shopify response has status APPROVED");
  assert(res1.statement === validShopifyText, "Valid Shopify response returns exact approved script");
  assert(res1.validationReport.isGrounded === true, "Valid Shopify response is marked isGrounded: true");
  assert(res1.engineMetadata.isFallback === false, "Valid Shopify response is not marked fallback");
  assert(res1.engineMetadata.recoveryAttempts === 0, "Valid Shopify response required 0 recovery attempts");

  // -------------------------------------------------------------
  // TEST 2: An invalid Shopify response is blocked or recovered
  // -------------------------------------------------------------
  console.log("\n[2/12] Testing invalid Shopify response recovery & blocking...");
  // 2A: Recovery succeeds
  const mock2A = new MockModelProvider([
    { text: "I can offer the pilot for $250." }, // Turn 1: Invalid price
    { text: "Our pricing is firmly set. The pilot price is exactly $400, and our monthly plan is $900." } // Turn 2: Recovered
  ]);
  const engine2A = new GenericSalesEngine({
    modelProvider: mock2A,
    defaultAdapter: shopifyAdapter
  });
  const res2A = await engine2A.generateRecommendation("Can I get a discount?");
  assert(res2A.status === "APPROVED", "Recovered Shopify response has status APPROVED");
  assert(res2A.statement.includes("$400"), "Recovered Shopify response returns corrected script");
  assert(res2A.engineMetadata.recoveryAttempts === 1, "Recovery attempts recorded as 1");

  // 2B: Recovery fails -> Blocked
  const mock2B = new MockModelProvider([
    { text: "I can offer the pilot for $250." }, // Turn 1: Invalid price
    { text: "We can still do the pilot for $250." } // Turn 2: Still invalid
  ]);
  const engine2B = new GenericSalesEngine({
    modelProvider: mock2B,
    defaultAdapter: shopifyAdapter
  });
  const res2B = await engine2B.generateRecommendation("Can I get a discount?");
  assert(res2B.status === "BLOCKED", "Failed recovery transitions to BLOCKED");
  assert(res2B.statement === SAFE_FALLBACK_RECOMMENDATION, "Blocked result returns safe fallback statement");
  assert(res2B.engineMetadata.isFallback === true, "Blocked result marked isFallback: true");
  assert(!res2B.statement.includes("$250"), "Blocked result does not leak unapproved price");

  // -------------------------------------------------------------
  // TEST 3: A valid Ghostwriter response is approved
  // -------------------------------------------------------------
  console.log("\n[3/12] Testing valid Ghostwriter response approval...");
  const validGwText = "Our executive discovery sprint is $1,200, and our thought leadership retainer is $2,500 monthly.";
  const mock3 = new MockModelProvider([{ text: validGwText }]);
  const engine3 = new GenericSalesEngine({
    modelProvider: mock3,
    defaultAdapter: ghostwriterAdapter
  });
  const res3 = await engine3.generateRecommendation("What is your pricing?");
  assert(res3.status === "APPROVED", "Valid Ghostwriter response has status APPROVED");
  assert(res3.statement === validGwText, "Valid Ghostwriter response returns approved script");
  assert(res3.validationReport.isGrounded === true, "Valid Ghostwriter response isGrounded is true");

  // -------------------------------------------------------------
  // TEST 4: An invalid Ghostwriter response is blocked or recovered
  // -------------------------------------------------------------
  console.log("\n[4/12] Testing invalid Ghostwriter response recovery & blocking...");
  // 4A: Recovery succeeds on virality guarantee
  const mock4A = new MockModelProvider([
    { text: "I guarantee you will gain 50,000 followers and go viral every week." }, // Turn 1: Guarantee
    { text: "We do not guarantee follower counts or virality. The retainer is $2,500/mo." } // Turn 2: Recovered
  ]);
  const engine4A = new GenericSalesEngine({
    modelProvider: mock4A,
    defaultAdapter: ghostwriterAdapter
  });
  const res4A = await engine4A.generateRecommendation("Can you guarantee viral growth?");
  assert(res4A.status === "APPROVED", "Recovered Ghostwriter response approved after corrective feedback");
  assert(res4A.engineMetadata.recoveryAttempts === 1, "Ghostwriter recovery recorded 1 attempt");

  // 4B: Recovery fails -> Blocked
  const mock4B = new MockModelProvider([
    { text: "I guarantee 50,000 followers." },
    { text: "I still guarantee viral reach." }
  ]);
  const engine4B = new GenericSalesEngine({
    modelProvider: mock4B,
    defaultAdapter: ghostwriterAdapter
  });
  const res4B = await engine4B.generateRecommendation("Can you guarantee viral reach?");
  assert(res4B.status === "BLOCKED", "Repeated virality guarantee violation is BLOCKED");
  assert(res4B.statement === SAFE_FALLBACK_RECOMMENDATION, "Blocked Ghostwriter returns safe fallback");

  // -------------------------------------------------------------
  // TEST 5: A response with an unauthorized price is not approved
  // -------------------------------------------------------------
  console.log("\n[5/12] Testing unauthorized price rejection across adapters...");
  // 5A: Shopify unauthorized $300 rate
  const mock5A = new MockModelProvider([
    { text: "I can offer a special $300 rate." },
    { text: "I can do $300 for you." }
  ]);
  const engine5A = new GenericSalesEngine({
    modelProvider: mock5A,
    defaultAdapter: shopifyAdapter
  });
  const res5A = await engine5A.generateRecommendation("What is your best price?");
  assert(res5A.status === "BLOCKED", "Shopify unauthorized $300 price is BLOCKED");
  assert(!res5A.statement.includes("$300"), "Rejected $300 rate suppressed from recommendation");

  // 5B: Ghostwriter rejecting Shopify's $400 price (Product Independence)
  const mock5B = new MockModelProvider([
    { text: "I can do the engagement for $400." }, // Valid in Shopify, but unauthorized in Ghostwriter
    { text: "We can do the sprint for $400." }
  ]);
  const engine5B = new GenericSalesEngine({
    modelProvider: mock5B,
    defaultAdapter: ghostwriterAdapter
  });
  const res5B = await engine5B.generateRecommendation("Can you do $400?");
  assert(res5B.status === "BLOCKED", "Ghostwriter blocks Shopify $400 rate as unauthorized");

  // -------------------------------------------------------------
  // TEST 6: A response inventing a financial guarantee is not approved
  // -------------------------------------------------------------
  console.log("\n[6/12] Testing financial guarantee rejection...");
  const mock6 = new MockModelProvider([
    { text: "I guarantee you will make $2,000 and get a 30% revenue bump." },
    { text: "We guarantee a positive financial return." }
  ]);
  const engine6 = new GenericSalesEngine({
    modelProvider: mock6,
    defaultAdapter: shopifyAdapter
  });
  const res6 = await engine6.generateRecommendation("Guarantee me more revenue.");
  assert(res6.status === "BLOCKED", "Financial guarantee violation is BLOCKED");
  assert(res6.statement === SAFE_FALLBACK_RECOMMENDATION, "Guarantee statement replaced with safe fallback");

  // -------------------------------------------------------------
  // TEST 7: A response with fabricated evidence is not approved
  // -------------------------------------------------------------
  console.log("\n[7/12] Testing fabricated evidence detection...");
  const mock7 = new MockModelProvider([
    { text: "The screenshot proves our CAC is $12." },
    { text: "Our audit image confirms your CAC is $12." }
  ]);
  const engine7 = new GenericSalesEngine({
    modelProvider: mock7,
    defaultAdapter: shopifyAdapter
  });
  const res7 = await engine7.generateRecommendation("Show me proof of CAC.");
  assert(res7.status === "BLOCKED", "Fabricated visual evidence claim is BLOCKED");
  assert(!res7.statement.includes("$12"), "Fabricated CAC claim suppressed from statement");

  // -------------------------------------------------------------
  // TEST 8: A disclaimer does not override a detected violation
  // -------------------------------------------------------------
  console.log("\n[8/12] Testing disclaimer bypass rejection...");
  const mock8 = new MockModelProvider([
    { text: "I don't have verified evidence, but the screenshot suggests you're losing customers." },
    { text: "I don't have verified revenue, although assuming your revenue is 100,000/month, I recommend storefront testing." }
  ]);
  const engine8 = new GenericSalesEngine({
    modelProvider: mock8,
    defaultAdapter: shopifyAdapter
  });
  const res8 = await engine8.generateRecommendation("Are we losing customers?");
  assert(res8.status === "BLOCKED", "Superficial disclaimers cannot bypass validation gate");
  assert(res8.statement === SAFE_FALLBACK_RECOMMENDATION, "Bypass attempt blocked with safe fallback");

  // -------------------------------------------------------------
  // TEST 9: Failed recovery cannot accidentally return rejected response
  // -------------------------------------------------------------
  console.log("\n[9/12] Testing that rejected text is NEVER returned on failed recovery...");
  const dangerousRejectedText = "Sure, we will rebuild your entire store and manage paid ads for $250.";
  const dangerousRecoveryText = "We can add paid ads for free to your pilot.";
  const mock9 = new MockModelProvider([
    { text: dangerousRejectedText },
    { text: dangerousRecoveryText }
  ]);
  const engine9 = new GenericSalesEngine({
    modelProvider: mock9,
    defaultAdapter: shopifyAdapter
  });
  const res9 = await engine9.generateRecommendation("Rebuild my store for $250.");
  assert(res9.status === "BLOCKED", "Dangerous multi-violation response is BLOCKED");
  assert(res9.statement !== dangerousRejectedText, "Rejected Turn 1 response is not returned");
  assert(res9.statement !== dangerousRecoveryText, "Rejected Turn 2 response is not returned");
  assert(res9.statement === SAFE_FALLBACK_RECOMMENDATION, "Safe fallback strictly returned");

  // -------------------------------------------------------------
  // TEST 10: Model-provider errors do not become approved recommendations
  // -------------------------------------------------------------
  console.log("\n[10/12] Testing model-provider error fail-safe...");
  const mock10 = new MockModelProvider([
    { error: new Error("Resource exhausted: Status 429 Rate Limit Exceeded") }
  ]);
  const engine10 = new GenericSalesEngine({
    modelProvider: mock10,
    defaultAdapter: shopifyAdapter
  });
  const res10 = await engine10.generateRecommendation("What is our revenue?");
  assert(res10.status === "BLOCKED", "Model provider error results in status BLOCKED");
  assert(res10.statement === SAFE_FALLBACK_RECOMMENDATION, "Model provider error returns safe fallback statement");
  assert(res10.validationReport.isGrounded === false, "Error response marked isGrounded: false");
  assert(res10.validationReport.unsupportedClaims.some(c => c.includes("Model provider error")), "Diagnostic contains error message");

  // -------------------------------------------------------------
  // TEST 11: Validation metadata accurately reflects final returned result
  // -------------------------------------------------------------
  console.log("\n[11/12] Testing validation metadata accuracy...");
  // Approved direct
  assert(res1.engineMetadata.turnsCount === 1, "Direct approved has turnsCount 1");
  assert(res1.engineMetadata.recoveryAttempts === 0, "Direct approved has 0 recovery attempts");
  assert(res1.engineMetadata.isFallback === false, "Direct approved isFallback is false");

  // Approved recovered
  assert(res2A.engineMetadata.turnsCount === 2, "Recovered approved has turnsCount 2");
  assert(res2A.engineMetadata.recoveryAttempts === 1, "Recovered approved has 1 recovery attempt");
  assert(res2A.engineMetadata.isFallback === false, "Recovered approved isFallback is false");

  // Blocked fallback
  assert(res2B.engineMetadata.recoveryAttempts === 1, "Blocked fallback has 1 recovery attempt");
  assert(res2B.engineMetadata.isFallback === true, "Blocked fallback isFallback is true");
  assert(Boolean(res2B.engineMetadata.rawUnapprovedStatement), "Blocked fallback preserves rawUnapprovedStatement for diagnostics");

  // -------------------------------------------------------------
  // TEST 12: Existing tool execution restrictions remain intact
  // -------------------------------------------------------------
  console.log("\n[12/12] Testing tool execution restrictions and schema fail-closed...");
  // Model requests unauthorized tool call
  const mock12 = new MockModelProvider([
    {
      functionCalls: [{ name: "unauthorizedDatabaseQuery", args: { query: "SELECT * FROM users" } }]
    },
    { text: "The pilot price is $400, and the monthly plan is $900." }
  ]);
  const engine12 = new GenericSalesEngine({
    modelProvider: mock12,
    defaultAdapter: shopifyAdapter
  });
  const res12 = await engine12.generateRecommendation("Run a database query.");
  assert(res12.toolsUsed.length === 1, "Logged 1 tool call");
  assert(res12.toolsUsed[0].tool === "unauthorizedDatabaseQuery", "Recorded unauthorized tool call");
  assert(res12.toolsUsed[0].result.error.includes("Unauthorized tool call"), "Unauthorized tool rejected fail-closed");

  console.log("\n--------------------------------------------------");
  console.log(`Approval Gate Tests Summary: Successes: ${passed} | Failures: ${failed} | Total: ${passed + failed}`);
  console.log("==================================================");

  return { passed, failed, total: passed + failed };
}
