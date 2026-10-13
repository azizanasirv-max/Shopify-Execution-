/**
 * Phase 1 - Provider-agnostic LLM layer validation suite.
 *
 * Fully deterministic and offline (no network). Verifies:
 * 1. Provider isolation: Groq and Gemini request formats are self-contained.
 * 2. Secrets: API keys travel in headers, never in the URL.
 * 3. Registry: Groq is the default provider; Gemini remains selectable.
 * 4. Legacy adapter: engine contract is preserved over a provider-agnostic core.
 * 5. Streaming: incremental deltas assemble correctly (Groq SSE + engine).
 * 6. Usage limits: token budget enforcement and usage aggregation.
 * 7. Errors: provider error/rate-limit propagation.
 * 8. Cancellation: AbortSignal is honoured.
 * 9. Stale responses: duplicate suppression + deterministic routing skip calls.
 * 10. Security: streaming never emits unapproved text.
 */

import {
  GroqProvider,
  GroqApiError,
  GeminiProvider,
  LegacyModelProviderAdapter,
  TokenBudget,
  TokenBudgetExceededError,
  UsageTracker,
  estimateTokens,
  createLlmProvider,
  resolveProviderId,
  decideRouting,
  withConciseDirective,
  countWords
} from "../engine/llm/index.js";
import { GenericSalesEngine } from "../engine/generic-sales-engine.js";
import { ShopifySalesAdapter } from "../sales-api/shopify-adapter.js";
import { ModelProvider, SAFE_FALLBACK_RECOMMENDATION, SalesRecommendation } from "../engine/types.js";

const VALID_SHOPIFY_TEXT = "Our pilot price is exactly $400, and our monthly ongoing plan is $900.";
const INVALID_SHOPIFY_TEXT = "I can offer the pilot for $250.";

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

class CannedModelProvider implements ModelProvider {
  public callCount = 0;
  constructor(private responses: Array<{ text?: string; functionCalls?: any[]; error?: Error }>) {}
  async generateContent() {
    this.callCount++;
    const next = this.responses.shift();
    if (!next) return { text: "Default mock response" };
    if (next.error) throw next.error;
    return { text: next.text, functionCalls: next.functionCalls };
  }
}

export async function runLlmProviderTests(): Promise<{ passed: number; failed: number; total: number }> {
  console.log("==================================================");
  console.log("   RUNNING PROVIDER-AGNOSTIC LLM VALIDATION SUITE  ");
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

  // -----------------------------------------------------------------
  // 1. Groq provider: request format + secret isolation
  // -----------------------------------------------------------------
  console.log("\n[1] Groq provider request format and secret isolation...");
  let groqUrl = "";
  let groqInit: any = null;
  const groqMockFetch = (async (url: any, init: any) => {
    groqUrl = String(url);
    groqInit = init;
    return jsonResponse({
      choices: [{ message: { content: "Groq says hello", tool_calls: [{ id: "c1", type: "function", function: { name: "get_pricing", arguments: '{"plan":"pilot"}' } }] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    });
  }) as unknown as typeof fetch;

  const groq = new GroqProvider({ apiKey: "SECRET_GROQ_KEY", defaultModel: "llama-3.1-8b-instant", fetchImpl: groqMockFetch });
  const groqResult = await groq.generate({
    systemInstruction: "You are a sales copilot.",
    messages: [{ role: "user", content: "What is the price?" }],
    tools: [{ name: "get_pricing", description: "Get pricing", parameters: { type: "object", properties: { plan: { type: "string" } } } }]
  });

  assert(!groqUrl.includes("SECRET_GROQ_KEY"), "Groq API key is not present in the request URL");
  assert(groqInit.headers.Authorization === "Bearer SECRET_GROQ_KEY", "Groq API key is sent via the Authorization header");
  const groqBody = JSON.parse(groqInit.body);
  assert(groqBody.model === "llama-3.1-8b-instant", "Groq body carries the configured model");
  assert(groqBody.messages[0].role === "system", "Groq body includes the system instruction as a system message");
  assert(groqBody.tools[0].type === "function" && groqBody.tools[0].function.name === "get_pricing", "Groq body maps tools to OpenAI function format");
  assert(groqResult.text === "Groq says hello", "Groq text response parsed");
  assert(groqResult.toolCalls?.[0]?.name === "get_pricing", "Groq tool calls parsed");
  assert(groqResult.toolCalls?.[0]?.args?.plan === "pilot", "Groq tool call arguments parsed from JSON string");
  assert(groqResult.usage?.totalTokens === 18, "Groq usage parsed from provider response");

  // -----------------------------------------------------------------
  // 2. Groq provider: streaming SSE
  // -----------------------------------------------------------------
  console.log("\n[2] Groq provider streaming...");
  const groqStreamFetch = (async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"Say "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"this "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"next."}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
    'data: [DONE]\n\n'
  ])) as unknown as typeof fetch;
  const groqStream = new GroqProvider({ apiKey: "SECRET_GROQ_KEY", fetchImpl: groqStreamFetch });
  const deltas: string[] = [];
  const streamResult = await groqStream.generateStream(
    { messages: [{ role: "user", content: "hi" }] },
    (d) => { if (d.textDelta) deltas.push(d.textDelta); }
  );
  assert(deltas.length === 3, "Groq streaming surfaces one delta per SSE frame");
  assert(streamResult.text === "Say this next.", "Groq streaming assembles the full text");
  assert(streamResult.usage?.totalTokens === 8, "Groq streaming captures usage from the final frame");

  // -----------------------------------------------------------------
  // 3. Provider errors + rate limits
  // -----------------------------------------------------------------
  console.log("\n[3] Provider error propagation...");
  const rateLimitedFetch = (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
  const rateLimited = new GroqProvider({ apiKey: "k", fetchImpl: rateLimitedFetch });
  let rateError: any = null;
  try {
    await rateLimited.generate({ messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    rateError = e;
  }
  assert(rateError instanceof GroqApiError && rateError.status === 429, "Groq 429 surfaces as GroqApiError(429)");

  const serverErrorFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  const serverErrProvider = new GroqProvider({ apiKey: "k", fetchImpl: serverErrorFetch });
  let serverError: any = null;
  try {
    await serverErrProvider.generate({ messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    serverError = e;
  }
  assert(serverError instanceof GroqApiError && serverError.status === 500, "Groq 5xx surfaces as GroqApiError(500)");

  // -----------------------------------------------------------------
  // 4. Cancellation
  // -----------------------------------------------------------------
  console.log("\n[4] Request cancellation...");
  const hangingFetch = ((_url: any, init: any) => new Promise((_resolve, reject) => {
    const signal: AbortSignal | undefined = init?.signal;
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort);
  })) as unknown as typeof fetch;
  const cancellable = new GroqProvider({ apiKey: "k", timeoutMs: 10000, fetchImpl: hangingFetch });
  const controller = new AbortController();
  const cancelPromise = cancellable.generate({ messages: [{ role: "user", content: "hi" }], abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  let cancelError: any = null;
  try {
    await cancelPromise;
  } catch (e) {
    cancelError = e;
  }
  assert(cancelError !== null, "Aborted request rejects instead of hanging");
  assert(/abort|timed out/i.test(cancelError?.message || ""), "Aborted request reports an abort/timeout error");

  // -----------------------------------------------------------------
  // 5. Gemini provider: header auth, key never in URL
  // -----------------------------------------------------------------
  console.log("\n[5] Gemini provider header authentication...");
  let geminiUrl = "";
  let geminiInit: any = null;
  const geminiMockFetch = (async (url: any, init: any) => {
    geminiUrl = String(url);
    geminiInit = init;
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "Gemini line" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } });
  }) as unknown as typeof fetch;
  const gemini = new GeminiProvider({ apiKey: "SECRET_GEMINI_KEY", fetchImpl: geminiMockFetch });
  const geminiResult = await gemini.generate({ messages: [{ role: "user", content: "hi" }] });
  assert(!geminiUrl.includes("SECRET_GEMINI_KEY"), "Gemini API key is not present in the request URL");
  assert(!geminiUrl.includes("key="), "Gemini request URL has no key query parameter");
  assert(geminiInit.headers["x-goog-api-key"] === "SECRET_GEMINI_KEY", "Gemini API key is sent via x-goog-api-key header");
  assert(geminiResult.text === "Gemini line", "Gemini text response parsed");
  assert(geminiResult.usage?.totalTokens === 6, "Gemini usage parsed");

  // -----------------------------------------------------------------
  // 6. Registry: Groq default, Gemini selectable, fail-closed on missing key
  // -----------------------------------------------------------------
  console.log("\n[6] Provider registry selection...");
  assert(resolveProviderId({}) === "groq", "Default provider is Groq when unset");
  assert(resolveProviderId({ LLM_PROVIDER: "GEMINI" }) === "gemini", "LLM_PROVIDER=gemini selects Gemini (case-insensitive)");
  assert(createLlmProvider({ GROQ_API_KEY: "k" })?.id === "groq", "Registry builds a Groq provider when GROQ_API_KEY is set");
  assert(createLlmProvider({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" })?.id === "gemini", "Registry builds a Gemini provider when selected");
  assert(createLlmProvider({}) === null, "Registry returns null (fail closed) when no key is configured");
  assert(createLlmProvider({ LLM_PROVIDER: "gemini", GROQ_API_KEY: "k" }) === null, "Selected provider without its key fails closed");

  // -----------------------------------------------------------------
  // 7. Legacy adapter: preserves the engine contract
  // -----------------------------------------------------------------
  console.log("\n[7] Legacy adapter contract preservation...");
  const adapterCapture: { body?: any } = {};
  const adapterFetch = (async (_url: any, init: any) => {
    adapterCapture.body = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "c9", type: "function", function: { name: "get_pricing", arguments: '{}' } }] }, finish_reason: "tool_calls" }] });
  }) as unknown as typeof fetch;
  const adapter = new LegacyModelProviderAdapter(new GroqProvider({ apiKey: "k", fetchImpl: adapterFetch }));
  const legacyResult = await adapter.generateContent({
    model: "llama-3.1-8b-instant",
    contents: [
      { role: "user", parts: [{ text: "prior user turn" }] },
      { role: "model", parts: [{ text: "prior model turn" }] },
      { role: "user", parts: [{ text: "What is the price?" }] }
    ],
    config: { systemInstruction: "SYS", tools: [{ functionDeclarations: [{ name: "get_pricing", description: "d", parameters: { type: "OBJECT", properties: {}, required: [] } }] }] }
  });
  assert(adapterCapture.body.messages.length === 4, "Adapter converts Gemini-shaped contents into normalized messages (+ system)");
  assert(adapterCapture.body.messages[0].role === "system" && adapterCapture.body.messages[0].content === "SYS", "Adapter forwards system instruction");
  assert(adapterCapture.body.messages[1].role === "user" && adapterCapture.body.messages[2].role === "assistant", "Adapter maps model role to assistant");
  assert(adapterCapture.body.tools[0].function.name === "get_pricing", "Adapter converts functionDeclarations to OpenAI tools");
  assert(legacyResult.functionCalls?.[0]?.name === "get_pricing", "Adapter maps tool calls back to legacy functionCalls");
  assert(adapter.supportsStreaming() === true, "Adapter reports streaming support");

  // -----------------------------------------------------------------
  // 8. Token budget + usage tracking
  // -----------------------------------------------------------------
  console.log("\n[8] Token budget enforcement and usage tracking...");
  const budget = new TokenBudget({ maxTotalTokens: 100, maxRequestTokens: 40 });
  let budgetError: any = null;
  try {
    budget.assertWithinBudget(41);
  } catch (e) {
    budgetError = e;
  }
  assert(budgetError instanceof TokenBudgetExceededError, "Per-request token cap is enforced");
  budget.assertWithinBudget(40);
  assert(true, "Request within the per-request cap is allowed");
  budget.record({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  assert(budget.usage.totalTokens === 30, "Token usage accumulates");
  assert(budget.remaining === 70, "Remaining budget computed");

  const cumulativeBudget = new TokenBudget({ maxTotalTokens: 50 });
  cumulativeBudget.record({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  let cumulativeError: any = null;
  try {
    cumulativeBudget.assertWithinBudget(21);
  } catch (e) {
    cumulativeError = e;
  }
  assert(cumulativeError instanceof TokenBudgetExceededError, "Cumulative budget is enforced");
  cumulativeBudget.assertWithinBudget(20);
  assert(true, "Request within remaining cumulative budget is allowed");

  const tracker = new UsageTracker();
  tracker.record("groq", { inputTokens: 5, outputTokens: 5, totalTokens: 10 });
  tracker.record("groq", { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  const snapshot = tracker.snapshot();
  assert(snapshot.groq.totalTokens === 12 && snapshot.groq.requests === 2, "UsageTracker aggregates per provider");
  assert(estimateTokens("12345678") === 2, "Local token estimate is deterministic (~4 chars/token)");

  // -----------------------------------------------------------------
  // 9. End-to-end: engine over a Groq-formatted provider
  // -----------------------------------------------------------------
  console.log("\n[9] Engine integration over provider-agnostic transport...");
  const e2eFetch = (async () => jsonResponse({ choices: [{ message: { content: VALID_SHOPIFY_TEXT }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } })) as unknown as typeof fetch;
  const e2eAdapter = new LegacyModelProviderAdapter(new GroqProvider({ apiKey: "k", fetchImpl: e2eFetch }));
  const e2eBudget = new TokenBudget({ maxTotalTokens: 100000 });
  const e2eTracker = new UsageTracker();
  const e2eEngine = new GenericSalesEngine({
    modelProvider: e2eAdapter,
    modelName: "llama-3.1-8b-instant",
    defaultAdapter: shopifyAdapter,
    providerId: "groq",
    tokenBudget: e2eBudget,
    usageTracker: e2eTracker
  });
  const e2eRec = await e2eEngine.generateRecommendation("What is the price?");
  assert(e2eRec.status === "APPROVED", "Approved recommendation flows through the provider-agnostic transport");
  assert((e2eRec.engineMetadata as any).usage?.totalTokens === 50, "Engine records provider usage in metadata");
  assert(e2eTracker.snapshot().groq?.totalTokens === 50, "Engine reports usage to the shared tracker");
  assert(e2eBudget.usage.totalTokens === 50, "Engine records usage against the token budget");

  // -----------------------------------------------------------------
  // 10. Token budget blocks generation when exhausted
  // -----------------------------------------------------------------
  console.log("\n[10] Token budget exhaustion blocks model calls...");
  const exhaustedBudget = new TokenBudget({ maxTotalTokens: 1 });
  const exhaustedEngine = new GenericSalesEngine({
    modelProvider: new CannedModelProvider([{ text: VALID_SHOPIFY_TEXT }]),
    defaultAdapter: shopifyAdapter,
    tokenBudget: exhaustedBudget
  });
  const exhaustedRec = await exhaustedEngine.generateRecommendation("What is the price?");
  assert(exhaustedRec.status === "BLOCKED", "Exhausted token budget yields a BLOCKED (fail-closed) recommendation");
  assert(exhaustedRec.statement === SAFE_FALLBACK_RECOMMENDATION, "Budget-exhausted result returns the safe fallback");

  // -----------------------------------------------------------------
  // 11. Validated streaming (security: never emits unapproved text)
  // -----------------------------------------------------------------
  console.log("\n[11] Validated streaming...");
  const streamEngine = new GenericSalesEngine({
    modelProvider: new CannedModelProvider([{ text: VALID_SHOPIFY_TEXT }]),
    defaultAdapter: shopifyAdapter
  });
  const approvedDeltas: string[] = [];
  const approvedRec = await streamEngine.generateRecommendationStream("What is the price?", undefined, (d) => approvedDeltas.push(d));
  assert(approvedDeltas.length > 1, "Approved recommendation is streamed in multiple incremental chunks");
  assert(approvedDeltas.join("") === approvedRec.statement, "Streamed chunks assemble exactly into the validated statement");

  const blockedEngine = new GenericSalesEngine({
    modelProvider: new CannedModelProvider([{ text: INVALID_SHOPIFY_TEXT }, { text: INVALID_SHOPIFY_TEXT }]),
    defaultAdapter: shopifyAdapter
  });
  const blockedDeltas: string[] = [];
  const blockedRec = await blockedEngine.generateRecommendationStream("Can I get a discount?", undefined, (d) => blockedDeltas.push(d));
  const blockedStreamed = blockedDeltas.join("");
  assert(blockedRec.status === "BLOCKED", "Invalid recommendation is blocked");
  assert(!blockedStreamed.includes("$250"), "Streaming never emits the unapproved price");
  assert(blockedStreamed === SAFE_FALLBACK_RECOMMENDATION, "Streaming emits only the safe fallback for blocked results");

  // -----------------------------------------------------------------
  // 12. Deterministic routing + stale/duplicate suppression
  // -----------------------------------------------------------------
  console.log("\n[12] Deterministic routing and stale-response suppression...");
  assert(decideRouting("mm-hmm").invokeModel === false, "Backchannel utterance is routed away from the model");
  assert(decideRouting("ok").invokeModel === false, "Short acknowledgement is routed away from the model");
  assert(decideRouting("What does the pilot cost?").invokeModel === true, "Substantive question is routed to the model");
  assert(decideRouting("").invokeModel === false, "Empty utterance is routed away from the model");

  const routingProvider = new CannedModelProvider([{ text: VALID_SHOPIFY_TEXT }]);
  const routingEngine = new GenericSalesEngine({ modelProvider: routingProvider, defaultAdapter: shopifyAdapter, deterministicRouting: true });
  const routingEvents: SalesRecommendation[] = [];
  await routingEngine.handleRealtimeTranscript({ speaker: "prospect", text: "mm-hmm", isFinal: true, timestamp: Date.now() }, (r) => routingEvents.push(r));
  assert(routingProvider.callCount === 0, "Deterministic routing prevents an unnecessary model call");
  assert(routingEvents.length === 0, "Non-actionable utterance produces no recommendation");

  const dedupProvider = new CannedModelProvider([{ text: VALID_SHOPIFY_TEXT }, { text: VALID_SHOPIFY_TEXT }]);
  const dedupEngine = new GenericSalesEngine({ modelProvider: dedupProvider, defaultAdapter: shopifyAdapter });
  const dedupEvents: SalesRecommendation[] = [];
  await dedupEngine.handleRealtimeTranscript({ speaker: "prospect", text: "What is the price?", isFinal: true, timestamp: Date.now() }, (r) => dedupEvents.push(r));
  await dedupEngine.handleRealtimeTranscript({ speaker: "prospect", text: "What is the price?", isFinal: true, timestamp: Date.now() }, (r) => dedupEvents.push(r));
  assert(dedupEvents.length === 1, "Duplicate final transcript is suppressed (stale-response guard)");
  assert(dedupProvider.callCount === 1, "Duplicate transcript triggers no additional model call");

  // -----------------------------------------------------------------
  // 13. Concise output directive
  // -----------------------------------------------------------------
  console.log("\n[13] Concise output constraints...");
  const instructed = withConciseDirective("BASE");
  assert(instructed.includes("OUTPUT CONSTRAINT:"), "Concise directive is appended to the system instruction");
  assert(instructed.includes("15") && instructed.includes("35"), "Concise directive encodes the 15-35 word target");
  assert(withConciseDirective(instructed) === instructed, "Concise directive is idempotent");
  assert(countWords(VALID_SHOPIFY_TEXT) <= 35, "Reference approved line is within the concise ceiling");
  assert(countWords(Array(60).fill("word").join(" ")) > 35, "Word counter detects over-length output");

  console.log("\n--------------------------------------------------");
  console.log(`LLM Provider Tests Summary: Passed: ${passed}, Failed: ${failed}, Total: ${passed + failed}`);
  console.log("==================================================");
  return { passed, failed, total: passed + failed };
}

if (process.argv[1] && process.argv[1].endsWith("llm-provider-tests.ts")) {
  runLlmProviderTests().then((summary) => {
    process.exit(summary.failed === 0 ? 0 : 1);
  });
}
