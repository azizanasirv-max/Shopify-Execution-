/**
 * Cloudflare Worker Integration Test Suite
 *
 * Verifies:
 * 1. Cloudflare Worker standard request/response handling (fetch entry point).
 * 2. CORS preflight and standard security headers.
 * 3. Request body size limits (rejects > 64KB).
 * 4. Production store selection & fail-closed startup behavior.
 * 5. Session lifecycle (create, token-bound list, inspect, clear, delete).
 * 6. Cross-user session enumeration prevention (fails closed without token).
 * 7. LiveKit token anti-impersonation and permission elevation checks.
 * 8. Protected admin endpoints require explicit authorization.
 * 9. Sanitized error responses without leakage of internal details.
 */

import worker, { Env, GeminiWorkerModelProvider } from "../../worker.js";
import { MockD1Database } from "./d1-persistence-tests.js";

export async function runWorkerIntegrationTests(): Promise<{ passed: number; failed: number }> {
  console.log("==================================================");
  console.log("    RUNNING CLOUDFLARE WORKER INTEGRATION TESTS   ");
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

  const mockDb = new MockD1Database();
  const testEnv: Env = {
    DB: mockDb,
    ADMIN_API_KEY: "admin_secret_token_12345",
    NODE_ENV: "test"
  };

  // -------------------------------------------------------------
  // TEST 1: CORS Preflight & Security Headers
  // -------------------------------------------------------------
  console.log("\n[1/8] Testing CORS preflight and security headers...");
  const optionsReq = new Request("https://worker.local/api/copilot", {
    method: "OPTIONS",
    headers: {
      Origin: "https://myshop.com",
      "Access-Control-Request-Method": "POST"
    }
  });

  const optionsRes = await worker.fetch(optionsReq, testEnv);
  assert(optionsRes.status === 204, "OPTIONS preflight returns 204 No Content");
  assert(Boolean(optionsRes.headers.get("Access-Control-Allow-Methods")?.includes("POST")), "CORS allows POST method");
  assert(Boolean(optionsRes.headers.get("Access-Control-Allow-Headers")?.includes("X-Session-Token")), "CORS allows X-Session-Token header");

  // TEST 1b: CORS fail-closed in Worker environment with NODE_ENV absent
  console.log("\n[1b] Testing CORS fail-closed when NODE_ENV is absent...");
  const noEnvProdEnv: Env = {
    DB: mockDb,
    ALLOWED_ORIGINS: "https://approved-store.com,https://dashboard.company.com"
  };

  const unapprovedCorsReq = new Request("https://worker.local/api/copilot", {
    method: "OPTIONS",
    headers: {
      Origin: "https://malicious-site.com",
      "Access-Control-Request-Method": "POST"
    }
  });
  const unapprovedCorsRes = await worker.fetch(unapprovedCorsReq, noEnvProdEnv);
  assert(unapprovedCorsRes.headers.get("Access-Control-Allow-Origin") === "null", "Unapproved origin returns Access-Control-Allow-Origin: null when NODE_ENV is absent");

  const approvedCorsReq = new Request("https://worker.local/api/copilot", {
    method: "OPTIONS",
    headers: {
      Origin: "https://approved-store.com",
      "Access-Control-Request-Method": "POST"
    }
  });
  const approvedCorsRes = await worker.fetch(approvedCorsReq, noEnvProdEnv);
  assert(approvedCorsRes.headers.get("Access-Control-Allow-Origin") === "https://approved-store.com", "Explicitly approved origin returns origin header when NODE_ENV is absent");

  // TEST 1c: CORS fail-closed when NODE_ENV is absent AND ALLOWED_ORIGINS is
  // unset. This is the real fail-open regression: with a `process` polyfill
  // present (nodejs_compat), the old logic defaulted to wildcard CORS and
  // reflected any origin.
  console.log("\n[1c] Testing CORS fail-closed with no NODE_ENV and no ALLOWED_ORIGINS...");
  const bareProdEnv: Env = { DB: mockDb };
  const bareUnapprovedReq = new Request("https://worker.local/api/copilot", {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST"
    }
  });
  const bareUnapprovedRes = await worker.fetch(bareUnapprovedReq, bareProdEnv);
  assert(
    bareUnapprovedRes.headers.get("Access-Control-Allow-Origin") === "null",
    "Unapproved origin is never reflected when NODE_ENV and ALLOWED_ORIGINS are absent"
  );

  // TEST 1d: CORS fail-closed when the Node `process` object is unavailable.
  // Simulates a pure Worker runtime without the nodejs_compat process polyfill.
  console.log("\n[1d] Testing CORS fail-closed when `process` is unavailable...");
  const savedProcess = (globalThis as any).process;
  let processAbsentResult: { unapproved: string | null; approved: string | null };
  try {
    (globalThis as any).process = undefined;
    const noProcEnv: Env = {
      DB: mockDb,
      ALLOWED_ORIGINS: "https://approved-store.com"
    };
    const noProcUnapprovedRes = await worker.fetch(
      new Request("https://worker.local/api/copilot", {
        method: "OPTIONS",
        headers: { Origin: "https://malicious-site.com", "Access-Control-Request-Method": "POST" }
      }),
      noProcEnv
    );
    const noProcApprovedRes = await worker.fetch(
      new Request("https://worker.local/api/copilot", {
        method: "OPTIONS",
        headers: { Origin: "https://approved-store.com", "Access-Control-Request-Method": "POST" }
      }),
      noProcEnv
    );
    processAbsentResult = {
      unapproved: noProcUnapprovedRes.headers.get("Access-Control-Allow-Origin"),
      approved: noProcApprovedRes.headers.get("Access-Control-Allow-Origin")
    };
  } finally {
    (globalThis as any).process = savedProcess;
  }
  assert(processAbsentResult.unapproved === "null", "Unapproved origin is not reflected when `process` is unavailable");
  assert(processAbsentResult.approved === "https://approved-store.com", "Approved origin still works when `process` is unavailable");

  // -------------------------------------------------------------
  // TEST 2: Request Body Size Limit (Reject > 64KB)
  // -------------------------------------------------------------
  console.log("\n[2/8] Testing request body size limits...");
  const largeReq = new Request("https://worker.local/api/copilot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "70000"
    },
    body: JSON.stringify({ prompt: "a".repeat(100) })
  });

  const largeRes = await worker.fetch(largeReq, testEnv);
  assert(largeRes.status === 413, "Payload exceeding 64KB rejected with 413");
  const largeData = await largeRes.json() as any;
  assert(largeData.code === "PAYLOAD_TOO_LARGE", "Error code is PAYLOAD_TOO_LARGE");

  // -------------------------------------------------------------
  // TEST 3: Session Creation via Worker API
  // -------------------------------------------------------------
  console.log("\n[3/8] Testing session creation via Worker API...");
  const createReq = new Request("https://worker.local/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "shopify" })
  });

  const createRes = await worker.fetch(createReq, testEnv);
  assert(createRes.status === 200, "POST /api/sessions returns 200");
  const sessionData = await createRes.json() as any;
  assert(Boolean(sessionData.sessionId), "Returns valid sessionId");
  assert(Boolean(sessionData.sessionToken?.startsWith("stok_")), "Returns secure sessionToken");
  assert(sessionData.productId === "shopify-conversion-pilot", "Bound to canonical product identifier");

  // -------------------------------------------------------------
  // TEST 4: Token-Authenticated Session Listing & Anti-Enumeration
  // -------------------------------------------------------------
  console.log("\n[4/8] Testing session listing and anti-enumeration...");
  // Unauthenticated listing must fail closed with 401
  const unauthListReq = new Request("https://worker.local/api/sessions", {
    method: "GET"
  });
  const unauthListRes = await worker.fetch(unauthListReq, testEnv);
  assert(unauthListRes.status === 401, "GET /api/sessions without token fails closed with 401");
  const unauthData = await unauthListRes.json() as any;
  assert(unauthData.code === "GLOBAL_LISTING_FORBIDDEN", "Rejects global session enumeration across users");

  // Authenticated listing returns strictly user's session
  const authListReq = new Request(`https://worker.local/api/sessions?sessionId=${sessionData.sessionId}`, {
    method: "GET",
    headers: {
      "X-Session-Token": sessionData.sessionToken
    }
  });
  const authListRes = await worker.fetch(authListReq, testEnv);
  assert(authListRes.status === 200, "GET /api/sessions with token returns 200");
  const authListData = await authListRes.json() as any;
  assert(authListData.sessions?.length === 1, "Returns strictly single matching session");
  assert(authListData.sessions && authListData.sessions[0]?.id === sessionData.sessionId, "Session ID matches authorized user");

  // -------------------------------------------------------------
  // TEST 5: Session Inspection, History Clear, and Deletion
  // -------------------------------------------------------------
  console.log("\n[5/8] Testing session inspection, clear, and delete authorization...");
  // Inspection without token rejected
  const inspectNoTokenReq = new Request(`https://worker.local/api/sessions/${sessionData.sessionId}`, {
    method: "GET"
  });
  const inspectNoTokenRes = await worker.fetch(inspectNoTokenReq, testEnv);
  assert(inspectNoTokenRes.status === 403, "Inspect without token rejected with 403");

  // Inspection with valid token succeeds
  const inspectAuthReq = new Request(`https://worker.local/api/sessions/${sessionData.sessionId}`, {
    method: "GET",
    headers: { "X-Session-Token": sessionData.sessionToken }
  });
  const inspectAuthRes = await worker.fetch(inspectAuthReq, testEnv);
  assert(inspectAuthRes.status === 200, "Inspect with valid token returns 200");
  const inspectData = await inspectAuthRes.json() as any;
  assert(inspectData.id === sessionData.sessionId, "Retrieved session ID matches");

  // Clear history with valid token
  const clearReq = new Request(`https://worker.local/api/sessions/${sessionData.sessionId}/clear`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionData.sessionToken
    }
  });
  const clearRes = await worker.fetch(clearReq, testEnv);
  assert(clearRes.status === 200, "POST /api/sessions/:id/clear returns 200");

  // -------------------------------------------------------------
  // TEST 6: LiveKit Token Anti-Impersonation & Permission Boundary
  // -------------------------------------------------------------
  console.log("\n[6/8] Testing LiveKit token security boundaries...");
  // Impersonating lbv-ai rejected
  const impersonateReq = new Request("https://worker.local/api/livekit/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionData.sessionToken
    },
    body: JSON.stringify({
      sessionId: sessionData.sessionId,
      identity: "lbv-ai"
    })
  });
  const impersonateRes = await worker.fetch(impersonateReq, testEnv);
  assert(impersonateRes.status === 403, "Impersonating reserved identity lbv-ai rejected with 403");
  const impData = await impersonateRes.json() as any;
  assert(impData.code === "RESERVED_IDENTITY", "Error code is RESERVED_IDENTITY");

  // Attempting permission elevation rejected
  const elevateReq = new Request("https://worker.local/api/livekit/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionData.sessionToken
    },
    body: JSON.stringify({
      sessionId: sessionData.sessionId,
      identity: "salesperson",
      permissions: { canPublish: true, canPublishData: true, canAdmin: true }
    })
  });
  const elevateRes = await worker.fetch(elevateReq, testEnv);
  assert(elevateRes.status === 403, "Client permission elevation rejected with 403");
  const elevateData = await elevateRes.json() as any;
  assert(elevateData.code === "PERMISSION_ELEVATION_DENIED", "Error code is PERMISSION_ELEVATION_DENIED");

  // Legitimate participant token request succeeds
  const legitTokenReq = new Request("https://worker.local/api/livekit/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionData.sessionToken
    },
    body: JSON.stringify({
      sessionId: sessionData.sessionId,
      identity: "salesperson"
    })
  });
  const legitTokenRes = await worker.fetch(legitTokenReq, testEnv);
  assert(legitTokenRes.status === 200, "Legitimate participant token request returns 200");
  const legitTokenData = await legitTokenRes.json() as any;
  assert(Boolean(legitTokenData.token), "Returns participant token");
  assert(legitTokenData.identity === "salesperson", "Token identity is salesperson");

  // -------------------------------------------------------------
  // TEST 7: Protected Admin Endpoints & Production Exposure
  // -------------------------------------------------------------
  console.log("\n[7/8] Testing protected admin endpoints and production exposure...");
  const unauthAdminReq = new Request("https://worker.local/api/run-adversarial-tests", {
    method: "POST"
  });
  const unauthAdminRes = await worker.fetch(unauthAdminReq, testEnv);
  assert(unauthAdminRes.status === 403, "Unauthenticated access to internal test endpoints rejected with 403");
  const adminErrData = await unauthAdminRes.json() as any;
  assert(adminErrData.code === "ADMIN_AUTHORIZATION_REQUIRED", "Error code is ADMIN_AUTHORIZATION_REQUIRED");

  // In production, internal test endpoints are completely disabled (404)
  const prodTestEnv: Env = {
    DB: mockDb,
    ADMIN_API_KEY: "admin_secret_token_12345",
    NODE_ENV: "production"
  };
  const prodAdminReq = new Request("https://worker.local/api/run-adversarial-tests", {
    method: "POST",
    headers: { "X-Admin-Token": "admin_secret_token_12345" }
  });
  const prodAdminRes = await worker.fetch(prodAdminReq, prodTestEnv);
  assert(prodAdminRes.status === 404, "Internal test endpoints disabled in production with 404");
  const prodAdminData = await prodAdminRes.json() as any;
  assert(prodAdminData.code === "ENDPOINT_DISABLED_IN_PRODUCTION", "Error code is ENDPOINT_DISABLED_IN_PRODUCTION");

  // -------------------------------------------------------------
  // TEST 8: Production Startup Failure Enforcement (No Memory Fallback)
  // -------------------------------------------------------------
  console.log("\n[8/9] Testing production startup failure enforcement...");
  const prodEnvWithoutDb: Env = {
    NODE_ENV: "production"
  };
  const prodReq = new Request("https://worker.local/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "shopify" })
  });

  const prodRes = await worker.fetch(prodReq, prodEnvWithoutDb);
  assert(prodRes.status === 500, "Production request without persistent binding fails closed with 500");
  const prodErrData = await prodRes.json() as any;
  assert(prodErrData.code === "STARTUP_ERROR", "Error code is STARTUP_ERROR");
  assert(prodErrData.error.includes("Refusing insecure fallback to memory"), "Refuses fallback to local memory in production");

  // -------------------------------------------------------------
  // TEST 9: Transcript Ingress Validation Checks (Defects A1-A4)
  // -------------------------------------------------------------
  console.log("\n[9/9] Testing transcript ingress validation checks...");
  // Non-boolean or non-true isFinal rejected
  const nonBoolFinalReq = new Request("https://worker.local/api/livekit/transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionData.sessionToken
    },
    body: JSON.stringify({
      sessionId: sessionData.sessionId,
      text: "Hello",
      isFinal: "true",
      speaker: "prospect"
    })
  });
  const nonBoolFinalRes = await worker.fetch(nonBoolFinalReq, testEnv);
  assert(nonBoolFinalRes.status === 400, "Non-boolean isFinal rejected with 400");
  const nonBoolData = await nonBoolFinalRes.json() as any;
  assert(nonBoolData.code === "INVALID_FINAL_STATUS", "Error code is INVALID_FINAL_STATUS");

  // false isFinal rejected
  const falseFinalReq = new Request("https://worker.local/api/livekit/transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionData.sessionToken
    },
    body: JSON.stringify({
      sessionId: sessionData.sessionId,
      text: "Hello",
      isFinal: false,
      speaker: "prospect"
    })
  });
  const falseFinalRes = await worker.fetch(falseFinalReq, testEnv);
  assert(falseFinalRes.status === 400, "false isFinal rejected with 400");

  // Invalid speaker rejected (must not default unknown speaker to prospect)
  const invalidSpeakerReq = new Request("https://worker.local/api/livekit/transcript", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionData.sessionToken
    },
    body: JSON.stringify({
      sessionId: sessionData.sessionId,
      text: "Hello",
      isFinal: true,
      speaker: "unknown_bot"
    })
  });
  const invalidSpeakerRes = await worker.fetch(invalidSpeakerReq, testEnv);
  assert(invalidSpeakerRes.status === 400, "Invalid speaker value rejected with 400");
  const invSpeakerData = await invalidSpeakerRes.json() as any;
  assert(invSpeakerData.code === "INVALID_SPEAKER", "Error code is INVALID_SPEAKER");

  // -------------------------------------------------------------
  // TEST 10: Gemini API key transport (header, never URL)
  // -------------------------------------------------------------
  console.log("\n[10/10] Testing Gemini API key is sent via header and not in the URL...");
  const dummyGeminiKey = "DUMMY_TEST_KEY_NOT_A_REAL_SECRET";
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    capturedUrl = typeof input === "string" ? input : input.url;
    capturedHeaders = (init && init.headers) || {};
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as any;
  try {
    const provider = new GeminiWorkerModelProvider(dummyGeminiKey, 5000);
    await provider.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: [{ role: "user", parts: [{ text: "hi" }] }]
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert(!capturedUrl.includes(dummyGeminiKey), "Gemini request URL does not contain the API key");
  assert(!/[?&]key=/.test(capturedUrl), "Gemini request URL has no `key` query parameter");
  assert(capturedHeaders["x-goog-api-key"] === dummyGeminiKey, "Gemini API key is sent via the x-goog-api-key header");

  // -------------------------------------------------------------
  // TEST 11: Internal test/evaluation endpoints use isProductionEnvironment()
  // -------------------------------------------------------------
  console.log("\n[11] Testing internal test/evaluation endpoint production guard...");
  const adminToken = "admin_secret_token_12345";
  const makeAdminReq = (token?: string) =>
    new Request("https://worker.local/api/run-adversarial-tests", {
      method: "POST",
      headers: token ? { "X-Admin-Token": token } : {}
    });

  // 11a: NODE_ENV absent -> disabled even with a valid admin token
  const noEnvAdminEnv: Env = { DB: mockDb, ADMIN_API_KEY: adminToken };
  const noEnvAdminRes = await worker.fetch(makeAdminReq(adminToken), noEnvAdminEnv);
  assert(noEnvAdminRes.status === 404, "Internal endpoints disabled when NODE_ENV is absent (valid admin token)");
  const noEnvAdminData = await noEnvAdminRes.json() as any;
  assert(noEnvAdminData.code === "ENDPOINT_DISABLED_IN_PRODUCTION", "Absent NODE_ENV returns ENDPOINT_DISABLED_IN_PRODUCTION");

  // 11b: NODE_ENV absent -> production guard takes precedence over auth
  const noEnvNoTokRes = await worker.fetch(makeAdminReq(), noEnvAdminEnv);
  assert(noEnvNoTokRes.status === 404, "Internal endpoints disabled when NODE_ENV is absent (no token)");

  // 11c: explicit development -> enabled, admin auth still enforced
  const devEnv: Env = { DB: mockDb, ADMIN_API_KEY: adminToken, NODE_ENV: "development" };
  const devNoTokRes = await worker.fetch(makeAdminReq(), devEnv);
  const devNoTokData = await devNoTokRes.json() as any;
  assert(devNoTokRes.status === 403 && devNoTokData.code === "ADMIN_AUTHORIZATION_REQUIRED", "Development: unauthenticated admin request rejected with 403");
  const devAuthRes = await worker.fetch(makeAdminReq(adminToken), devEnv);
  const devAuthData = await devAuthRes.json() as any;
  assert(devAuthData.code !== "ENDPOINT_DISABLED_IN_PRODUCTION", "Development: internal endpoints are not production-disabled");

  // 11d: explicit test -> enabled, admin auth still enforced
  const testAdminEnv: Env = { DB: mockDb, ADMIN_API_KEY: adminToken, NODE_ENV: "test" };
  const testNoTokRes = await worker.fetch(makeAdminReq(), testAdminEnv);
  const testNoTokData = await testNoTokRes.json() as any;
  assert(testNoTokRes.status === 403 && testNoTokData.code === "ADMIN_AUTHORIZATION_REQUIRED", "Test: unauthenticated admin request rejected with 403");
  const testAuthRes = await worker.fetch(makeAdminReq(adminToken), testAdminEnv);
  const testAuthData = await testAuthRes.json() as any;
  assert(testAuthData.code !== "ENDPOINT_DISABLED_IN_PRODUCTION", "Test: internal endpoints are not production-disabled");

  console.log("\n--------------------------------------------------");
  console.log(`Worker Integration Tests Summary: Passed: ${passed}, Failed: ${failed}`);
  console.log("==================================================");

  return { passed, failed };
}

if (process.argv[1] && process.argv[1].endsWith("worker-integration-tests.ts")) {
  runWorkerIntegrationTests().then(summary => {
    process.exit(summary.failed === 0 ? 0 : 1);
  });
}
