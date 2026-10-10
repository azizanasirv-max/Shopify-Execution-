/**
 * Deterministic Test Suite for Product Adapter Isolation & Session Scoping (Priority 2)
 *
 * Verifies that:
 * 1. A Shopify request receives Shopify context and tools.
 * 2. A Ghostwriter request receives Ghostwriter context and tools.
 * 3. An unknown product identifier is rejected.
 * 4. An unknown identifier never falls back to Shopify.
 * 5. Two concurrent requests using different adapters retain their own pricing and tools.
 * 6. A Shopify request cannot consume Ghostwriter tool results.
 * 7. A Ghostwriter request cannot consume Shopify evidence or offers.
 * 8. A session created for Shopify cannot silently switch to Ghostwriter.
 * 9. An invalid or mismatched session/product association is rejected.
 * 10. Concurrent requests cannot overwrite each other's conversation histories.
 * 11. Validation uses the adapter associated with the current request.
 * 12. A failed request cannot corrupt the next request's adapter selection or state.
 * 13. Unauthorized tools remain rejected.
 * 14. Approval-gate recovery and blocked-result behavior remain intact.
 */

import { GenericSalesEngine } from "../engine/generic-sales-engine.js";
import {
  ModelProvider,
  SAFE_FALLBACK_RECOMMENDATION,
  SalesApiAdapter
} from "../engine/types.js";
import { ShopifySalesAdapter } from "../sales-api/shopify-adapter.js";
import { GhostwriterSalesAdapter } from "../sales-api/ghostwriter-adapter.js";
import { AdapterRegistry, UnknownProductError } from "../engine/adapter-registry.js";
import {
  SessionManager,
  SessionNotFoundError,
  MismatchedSessionProductError
} from "../engine/session-manager.js";

/**
 * Deterministic Mock Model Provider for multi-turn simulated requests
 */
class DeterministicMockModelProvider implements ModelProvider {
  private queue: Array<{ text?: string; functionCalls?: any[]; error?: Error }>;
  public callCount = 0;
  public recordedConfigs: any[] = [];
  public recordedContents: any[] = [];

  constructor(responses: Array<{ text?: string; functionCalls?: any[]; error?: Error }>) {
    this.queue = [...responses];
  }

  async generateContent(params: { model: string; contents: any[]; config?: any }) {
    this.callCount++;
    this.recordedConfigs.push(params.config);
    this.recordedContents.push(params.contents);

    const next = this.queue.shift();
    if (!next) {
      return { text: "Default simulated response" };
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

export async function runAdapterIsolationTests(): Promise<{ passed: number; failed: number; total: number }> {
  console.log("==================================================");
  console.log("  RUNNING ADAPTER ISOLATION & SESSION SCOPE TESTS ");
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

  // Create isolated registry
  const registry = new AdapterRegistry();
  registry.register(shopifyAdapter, ["shopify", "shopify-pilot"]);
  registry.register(ghostwriterAdapter, ["ghostwriter", "ghostwriting"]);

  const sessionManager = new SessionManager();

  // -------------------------------------------------------------
  // TEST 1: A Shopify request receives Shopify context and tools
  // -------------------------------------------------------------
  console.log("\n[1/14] Testing Shopify request receives Shopify context and tools...");
  const mock1 = new DeterministicMockModelProvider([
    {
      functionCalls: [{ name: "getOffer", args: {} }]
    },
    {
      text: "Our Shopify pilot is $400 and monthly ongoing is $900."
    }
  ]);
  const engine1 = new GenericSalesEngine({
    modelProvider: mock1,
    adapterRegistry: registry
  });

  const res1 = await engine1.generateRecommendation("What is your pilot price?", {
    productId: "shopify"
  });

  assert(res1.status === "APPROVED", "Shopify request approved");
  assert(res1.engineMetadata.productId === "shopify-conversion-pilot", "Identifies Shopify canonical product ID");
  assert(res1.toolsUsed.length === 1 && res1.toolsUsed[0].tool === "getOffer", "Used Shopify getOffer tool");
  assert(res1.toolsUsed[0].result?.pilotPrice === 400, "Received authoritative Shopify pilot price ($400)");
  const config1 = mock1.recordedConfigs[0];
  const toolNames1 = config1?.tools?.[0]?.functionDeclarations?.map((d: any) => d.name) || [];
  assert(toolNames1.includes("getProspect") && toolNames1.includes("getOffer"), "Configured Shopify tool declarations");
  assert(!toolNames1.includes("getEditorialAudit"), "Does not include Ghostwriter tools in Shopify call");

  // -------------------------------------------------------------
  // TEST 2: A Ghostwriter request receives Ghostwriter context and tools
  // -------------------------------------------------------------
  console.log("\n[2/14] Testing Ghostwriter request receives Ghostwriter context and tools...");
  const mock2 = new DeterministicMockModelProvider([
    {
      functionCalls: [{ name: "getGhostwriterOffer", args: {} }]
    },
    {
      text: "Our executive ghostwriting pilot is $1,200, and our monthly retainer is $2,500."
    }
  ]);
  const engine2 = new GenericSalesEngine({
    modelProvider: mock2,
    adapterRegistry: registry
  });

  const res2 = await engine2.generateRecommendation("What does ghostwriting cost?", {
    productId: "ghostwriter"
  });

  assert(res2.status === "APPROVED", "Ghostwriter request approved");
  assert(res2.engineMetadata.productId === "ghostwriter-thought-leadership", "Identifies Ghostwriter canonical product ID");
  assert(res2.toolsUsed.length === 1 && res2.toolsUsed[0].tool === "getGhostwriterOffer", "Used Ghostwriter getGhostwriterOffer tool");
  assert(res2.toolsUsed[0].result?.pilotPrice === 1200, "Received authoritative Ghostwriter pilot price ($1,200)");
  const config2 = mock2.recordedConfigs[0];
  const toolNames2 = config2?.tools?.[0]?.functionDeclarations?.map((d: any) => d.name) || [];
  assert(toolNames2.includes("getEditorialAudit") && toolNames2.includes("getGhostwriterOffer"), "Configured Ghostwriter tool declarations");
  assert(!toolNames2.includes("getProspect"), "Does not include Shopify tools in Ghostwriter call");

  // -------------------------------------------------------------
  // TEST 3: An unknown product identifier is rejected
  // -------------------------------------------------------------
  console.log("\n[3/14] Testing rejection of unknown product identifier...");
  let unknownRejected = false;
  try {
    registry.resolve("unregistered-seo-tool");
  } catch (err: any) {
    if (err instanceof UnknownProductError) {
      unknownRejected = true;
    }
  }
  assert(unknownRejected, "Registry strictly rejects unregistered product identifier with UnknownProductError");
  assert(registry.has("unregistered-seo-tool") === false, "Registry.has returns false for unregistered product");

  // -------------------------------------------------------------
  // TEST 4: An unknown identifier never falls back to Shopify
  // -------------------------------------------------------------
  console.log("\n[4/14] Testing unknown identifier never falls back to Shopify...");
  let fellBackToShopify = false;
  try {
    const resolved = registry.resolve("malicious-or-unknown-product");
    if (resolved.id === shopifyAdapter.id) {
      fellBackToShopify = true;
    }
  } catch (err) {
    // Expected to throw, not return
  }
  assert(!fellBackToShopify, "Unknown identifier never falls back to Shopify adapter");
  assert(registry.getCanonicalId("malicious-or-unknown-product") === undefined, "Unknown identifier has no canonical ID");

  // -------------------------------------------------------------
  // TEST 5: Two concurrent requests using different adapters retain their own pricing and tools
  // -------------------------------------------------------------
  console.log("\n[5/14] Testing concurrent requests retain distinct pricing and tools...");
  const mockConcurrent = new DeterministicMockModelProvider([
    // Turn for request A (Shopify)
    {
      functionCalls: [{ name: "getOffer", args: {} }]
    },
    // Turn for request B (Ghostwriter)
    {
      functionCalls: [{ name: "getGhostwriterOffer", args: {} }]
    },
    // Second turn for request A (Shopify final)
    {
      text: "Our Shopify pilot is $400."
    },
    // Second turn for request B (Ghostwriter final)
    {
      text: "Our executive ghostwriting pilot is $1,200."
    }
  ]);

  const engineConcurrent = new GenericSalesEngine({
    modelProvider: mockConcurrent,
    adapterRegistry: registry
  });

  const sessionA = sessionManager.createSession(shopifyAdapter.id);
  const sessionB = sessionManager.createSession(ghostwriterAdapter.id);

  const [concurrentShopifyRes, concurrentGhostwriterRes] = await Promise.all([
    engineConcurrent.generateRecommendation("What is the Shopify pilot price?", {
      adapter: shopifyAdapter,
      session: sessionA
    }),
    engineConcurrent.generateRecommendation("What is the Ghostwriter pilot price?", {
      adapter: ghostwriterAdapter,
      session: sessionB
    })
  ]);

  assert(concurrentShopifyRes.status === "APPROVED", "Concurrent Shopify request approved");
  assert(concurrentShopifyRes.engineMetadata.productId === "shopify-conversion-pilot", "Concurrent Shopify request has shopify product ID");
  assert(concurrentShopifyRes.toolsUsed[0]?.tool === "getOffer", "Concurrent Shopify request invoked getOffer");
  assert(concurrentShopifyRes.statement.includes("$400"), "Concurrent Shopify request retains $400 pricing");

  assert(concurrentGhostwriterRes.status === "APPROVED", "Concurrent Ghostwriter request approved");
  assert(concurrentGhostwriterRes.engineMetadata.productId === "ghostwriter-thought-leadership", "Concurrent Ghostwriter request has ghostwriter product ID");
  assert(concurrentGhostwriterRes.toolsUsed[0]?.tool === "getGhostwriterOffer", "Concurrent Ghostwriter request invoked getGhostwriterOffer");
  assert(concurrentGhostwriterRes.statement.includes("$1,200"), "Concurrent Ghostwriter request retains $1,200 pricing");

  // -------------------------------------------------------------
  // TEST 6: A Shopify request cannot consume Ghostwriter tool results
  // -------------------------------------------------------------
  console.log("\n[6/14] Testing Shopify request cannot consume Ghostwriter tool results...");
  let shopifyRejectsGhostwriterTool = false;
  try {
    await shopifyAdapter.executeTool("getEditorialAudit");
  } catch (err: any) {
    shopifyRejectsGhostwriterTool = true;
  }
  assert(shopifyRejectsGhostwriterTool, "Shopify adapter rejects execution of Ghostwriter getEditorialAudit tool");

  // Model-level test: model generates Ghostwriter tool inside Shopify request
  const mock6 = new DeterministicMockModelProvider([
    {
      functionCalls: [{ name: "getEditorialAudit", args: {} }]
    },
    {
      text: "I was unable to retrieve that information."
    }
  ]);
  const engine6 = new GenericSalesEngine({
    modelProvider: mock6,
    adapterRegistry: registry
  });
  const res6 = await engine6.generateRecommendation("Run editorial audit", {
    adapter: shopifyAdapter
  });
  const badTool = res6.toolsUsed.find(t => t.tool === "getEditorialAudit");
  assert(!!badTool?.result?.error, "Shopify request marks Ghostwriter tool call as invalid/error");

  // -------------------------------------------------------------
  // TEST 7: A Ghostwriter request cannot consume Shopify evidence or offers
  // -------------------------------------------------------------
  console.log("\n[7/14] Testing Ghostwriter request cannot consume Shopify evidence or offers...");
  let gwRejectsShopifyEvidence = false;
  try {
    await ghostwriterAdapter.executeTool("getEvidence");
  } catch (err: any) {
    gwRejectsShopifyEvidence = true;
  }
  assert(gwRejectsShopifyEvidence, "Ghostwriter adapter rejects execution of Shopify getEvidence tool");

  let gwRejectsShopifyOffer = false;
  try {
    await ghostwriterAdapter.executeTool("getOffer");
  } catch (err: any) {
    gwRejectsShopifyOffer = true;
  }
  assert(gwRejectsShopifyOffer, "Ghostwriter adapter rejects execution of Shopify getOffer tool");

  // -------------------------------------------------------------
  // TEST 8: A session created for Shopify cannot silently switch to Ghostwriter
  // -------------------------------------------------------------
  console.log("\n[8/14] Testing session created for Shopify cannot switch to Ghostwriter...");
  const shopifySession = sessionManager.createSession(shopifyAdapter.id);
  let sessionSwitchRejected = false;
  try {
    sessionManager.validateSessionProduct(shopifySession.id, ghostwriterAdapter.id, registry);
  } catch (err: any) {
    if (err instanceof MismatchedSessionProductError) {
      sessionSwitchRejected = true;
    }
  }
  assert(sessionSwitchRejected, "SessionManager rejects cross-product session switch with MismatchedSessionProductError");
  assert(shopifySession.productId === shopifyAdapter.id, "Session remains bound to original Shopify product");

  // -------------------------------------------------------------
  // TEST 9: An invalid or mismatched session/product association is rejected
  // -------------------------------------------------------------
  console.log("\n[9/14] Testing invalid or mismatched session association rejection...");
  let invalidSessionRejected = false;
  try {
    sessionManager.validateSessionProduct("non-existent-session-id", shopifyAdapter.id, registry);
  } catch (err: any) {
    if (err instanceof SessionNotFoundError) {
      invalidSessionRejected = true;
    }
  }
  assert(invalidSessionRejected, "SessionManager rejects non-existent session with SessionNotFoundError");

  // -------------------------------------------------------------
  // TEST 10: Concurrent requests cannot overwrite each other's conversation histories
  // -------------------------------------------------------------
  console.log("\n[10/14] Testing conversation history isolation under concurrent requests...");
  const sess1 = sessionManager.createSession(shopifyAdapter.id);
  const sess2 = sessionManager.createSession(ghostwriterAdapter.id);

  const mockHistA = new DeterministicMockModelProvider([
    { text: "Shopify Answer 1" },
    { text: "Shopify Answer 2" },
    { text: "Shopify Answer 3" }
  ]);
  const mockHistB = new DeterministicMockModelProvider([
    { text: "Ghostwriter Answer 1" },
    { text: "Ghostwriter Answer 2" },
    { text: "Ghostwriter Answer 3" }
  ]);

  const engineHistA = new GenericSalesEngine({ modelProvider: mockHistA, defaultAdapter: shopifyAdapter });
  const engineHistB = new GenericSalesEngine({ modelProvider: mockHistB, defaultAdapter: ghostwriterAdapter });

  // Concurrently interleave requests across sessions
  await Promise.all([
    engineHistA.generateRecommendation("Shopify Prompt 1", { adapter: shopifyAdapter, session: sess1 }),
    engineHistB.generateRecommendation("Ghostwriter Prompt 1", { adapter: ghostwriterAdapter, session: sess2 }),
    engineHistA.generateRecommendation("Shopify Prompt 2", { adapter: shopifyAdapter, session: sess1 }),
    engineHistB.generateRecommendation("Ghostwriter Prompt 2", { adapter: ghostwriterAdapter, session: sess2 }),
    engineHistA.generateRecommendation("Shopify Prompt 3", { adapter: shopifyAdapter, session: sess1 }),
    engineHistB.generateRecommendation("Ghostwriter Prompt 3", { adapter: ghostwriterAdapter, session: sess2 })
  ]);

  assert(sess1.conversationHistory.length === 6, "Shopify session contains exactly 6 turns (3 pairs)");
  assert(sess2.conversationHistory.length === 6, "Ghostwriter session contains exactly 6 turns (3 pairs)");

  const shopifyTexts = sess1.conversationHistory.map(t => t.text || "");
  const ghostwriterTexts = sess2.conversationHistory.map(t => t.text || "");

  assert(!shopifyTexts.some(t => t.includes("Ghostwriter")), "Shopify history contains 0 Ghostwriter turns");
  assert(!ghostwriterTexts.some(t => t.includes("Shopify")), "Ghostwriter history contains 0 Shopify turns");
  assert(sess1.conversationHistory !== sess2.conversationHistory, "Session history array references are distinct");

  // -------------------------------------------------------------
  // TEST 11: Validation uses the adapter associated with the current request
  // -------------------------------------------------------------
  console.log("\n[11/14] Testing response validation uses request-scoped adapter...");
  // Ghostwriter rate ($1,200) is valid for Ghostwriter, but must be invalid for Shopify
  const ghostwriterRateStatement = "Our executive sprint is $1,200.";
  const shopifyValidationOfGw = shopifyAdapter.validateResponse(ghostwriterRateStatement, "What are your rates?");
  const gwValidationOfGw = ghostwriterAdapter.validateResponse(ghostwriterRateStatement, "What are your rates?");

  assert(!shopifyValidationOfGw.isGrounded || shopifyValidationOfGw.unsupportedClaims.length > 0,
    "Shopify validator rejects Ghostwriter $1,200 price as unauthorized commercial commitment");
  assert(gwValidationOfGw.isGrounded && gwValidationOfGw.unsupportedClaims.length === 0,
    "Ghostwriter validator approves its own authorized $1,200 price");

  // -------------------------------------------------------------
  // TEST 12: A failed request cannot corrupt the next request's adapter selection or state
  // -------------------------------------------------------------
  console.log("\n[12/14] Testing failed request does not corrupt subsequent requests...");
  const mockFailThenPass = new DeterministicMockModelProvider([
    // Request 1: Fails with model error
    { error: new Error("Simulated upstream model error") },
    // Request 2: Succeeds cleanly
    { text: "Our executive ghostwriting retainer is $2,500 monthly." }
  ]);

  const engineFailSafe = new GenericSalesEngine({
    modelProvider: mockFailThenPass,
    adapterRegistry: registry
  });

  const sessFail = sessionManager.createSession(shopifyAdapter.id);
  const sessNext = sessionManager.createSession(ghostwriterAdapter.id);

  // Request 1 fails safely
  const resFailed = await engineFailSafe.generateRecommendation("Tell me pricing", {
    adapter: shopifyAdapter,
    session: sessFail
  });
  assert(resFailed.status === "BLOCKED", "Failed request returns safe BLOCKED recommendation");
  assert(resFailed.statement === SAFE_FALLBACK_RECOMMENDATION, "Failed request returns SAFE_FALLBACK_RECOMMENDATION");

  // Request 2 succeeds and uses Ghostwriter
  const resSucceed = await engineFailSafe.generateRecommendation("What is the retainer?", {
    adapter: ghostwriterAdapter,
    session: sessNext
  });
  assert(resSucceed.status === "APPROVED", "Subsequent request completes with APPROVED status");
  assert(resSucceed.engineMetadata.productId === "ghostwriter-thought-leadership", "Subsequent request maintains Ghostwriter product");
  assert(resSucceed.statement.includes("$2,500"), "Subsequent request maintains Ghostwriter $2,500 pricing");

  // -------------------------------------------------------------
  // TEST 13: Unauthorized tools remain rejected
  // -------------------------------------------------------------
  console.log("\n[13/14] Testing unauthorized/undeclared tools rejection...");
  const mockUnauthTool = new DeterministicMockModelProvider([
    {
      functionCalls: [{ name: "execSystemCommand", args: { cmd: "whoami" } }]
    },
    {
      text: "I cannot execute system commands."
    }
  ]);

  const engineUnauth = new GenericSalesEngine({
    modelProvider: mockUnauthTool,
    defaultAdapter: shopifyAdapter
  });

  const resUnauth = await engineUnauth.generateRecommendation("Run command", {
    adapter: shopifyAdapter
  });
  const unauthLogged = resUnauth.toolsUsed.find(t => t.tool === "execSystemCommand");
  assert(!!unauthLogged?.result?.error, "Undeclared tool call is rejected by schema validator before execution");

  // -------------------------------------------------------------
  // TEST 14: Approval-gate recovery and blocked-result behavior remain intact
  // -------------------------------------------------------------
  console.log("\n[14/14] Testing approval-gate bounded recovery and blocked behavior under session scoping...");
  // 14A: Recovery succeeds under session scoping
  const mock14A = new DeterministicMockModelProvider([
    { text: "I can offer the pilot for $250." }, // Turn 1: Invalid price
    { text: "Our pricing is firm. The pilot price is exactly $400, and our monthly plan is $900." } // Turn 2: Recovered
  ]);
  const engine14A = new GenericSalesEngine({
    modelProvider: mock14A,
    defaultAdapter: shopifyAdapter
  });
  const sess14A = sessionManager.createSession(shopifyAdapter.id);
  const res14A = await engine14A.generateRecommendation("Can I get a discount?", {
    adapter: shopifyAdapter,
    session: sess14A
  });
  assert(res14A.status === "APPROVED", "Bounded recovery succeeds and approves recommendation");
  assert(res14A.statement.includes("$400"), "Recovered statement contains valid $400 price");
  assert(res14A.engineMetadata.recoveryAttempts === 1, "Recorded recoveryAttempts: 1");
  assert(res14A.engineMetadata.sessionId === sess14A.id, "Records correct sessionId in engineMetadata");

  // 14B: Failed recovery enforces BLOCKED and does not leak unapproved text
  const mock14B = new DeterministicMockModelProvider([
    { text: "I can offer the pilot for $250." }, // Turn 1: Invalid
    { text: "I can still do $250." } // Turn 2: Still invalid
  ]);
  const engine14B = new GenericSalesEngine({
    modelProvider: mock14B,
    defaultAdapter: shopifyAdapter
  });
  const sess14B = sessionManager.createSession(shopifyAdapter.id);
  const res14B = await engine14B.generateRecommendation("Can I get a discount?", {
    adapter: shopifyAdapter,
    session: sess14B
  });
  assert(res14B.status === "BLOCKED", "Failed recovery enforces BLOCKED status");
  assert(res14B.statement === SAFE_FALLBACK_RECOMMENDATION, "Blocked result returns SAFE_FALLBACK_RECOMMENDATION");
  assert(!res14B.statement.includes("$250"), "Unapproved text is never returned in statement");

  console.log("\n--------------------------------------------------");
  console.log(`Adapter Isolation Tests Summary: Passed: ${passed} | Failed: ${failed} | Total: ${passed + failed}`);
  console.log("==================================================");

  return { passed, failed, total: passed + failed };
}
