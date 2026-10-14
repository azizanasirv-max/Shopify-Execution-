/**
 * Dashboard UI & Worker Route Tests
 *
 * Deterministic, offline tests for the redesigned salesperson dashboard:
 *  1. Invitation-link helpers (routing, token scoping, URL scrubbing).
 *  2. Share/ clipboard fallback behaviour.
 *  3. In-memory call registry (no secrets stored).
 *  4. Hash route parsing.
 *  5. API client contracts + error handling (mocked fetch).
 *  6. Worker route: GET /api/service-profiles (read-only, no secrets).
 *
 * No network access and no real credentials are required.
 */

import worker, { Env } from "../../worker.js";
import { MockD1Database } from "./d1-persistence-tests.js";
import {
  isProspectRoute,
  parseProspectInvite,
  buildInviteUrl,
  toValidatedProspectUrl,
  urlExposesToken,
} from "../../src/sales/invite.js";
import { shareInvitation, copyToClipboard } from "../../src/sales/share.js";
import { CallRegistry } from "../../src/sales/sessionRegistry.js";
import { parseRoute, DEFAULT_ROUTE } from "../../src/sales/useHashRoute.js";
import { createSession, getSessionSummary, ApiError } from "../../src/sales/api.js";

export async function runDashboardUiTests(): Promise<{ passed: number; failed: number }> {
  console.log("==================================================");
  console.log("     RUNNING DASHBOARD UI & WORKER ROUTE TESTS     ");
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
  // 1. Invitation-link helpers
  // -------------------------------------------------------------
  console.log("\n[1/6] Invitation-link helpers...");

  assert(isProspectRoute("?join=1&sessionId=s1&token=t1") === true, "?join=1 is a prospect route");
  assert(isProspectRoute("?prospect=1") === true, "?prospect=1 is a prospect route");
  assert(isProspectRoute("") === false, "empty search is not a prospect route");
  assert(isProspectRoute("?console=1") === false, "unrelated query is not a prospect route");

  const parsed = parseProspectInvite("?join=1&sessionId=sess_123&token=tok_abc");
  assert(parsed.sessionId === "sess_123" && parsed.token === "tok_abc", "parses sessionId and token");

  const inviteUrl = buildInviteUrl("https://app.example.com", "/", "sess_123", "tok_abc");
  assert(inviteUrl.startsWith("https://app.example.com/?"), "invite URL uses the app origin");
  assert(inviteUrl.includes("join=1"), "invite URL carries the join flag");
  assert(inviteUrl.includes("sessionId=sess_123"), "invite URL carries the session id");
  assert(inviteUrl.includes("token=tok_abc"), "invite URL carries the scoped invitation token");
  assert(
    !inviteUrl.toLowerCase().includes("sessiontoken") && !inviteUrl.toLowerCase().includes("stok_"),
    "invite URL never contains a session authorization token"
  );

  let threw = false;
  try {
    buildInviteUrl("https://app.example.com", "/", "sess_123", "");
  } catch {
    threw = true;
  }
  assert(threw, "buildInviteUrl refuses to build a link without an invitation token");

  assert(toValidatedProspectUrl("/") === "/?join=1", "validated prospect URL drops the token");
  assert(urlExposesToken("?join=1&token=abc") === true, "detects a token still present in the URL");
  assert(urlExposesToken("?join=1") === false, "detects a scrubbed URL");

  // -------------------------------------------------------------
  // 2. Share fallback behaviour
  // -------------------------------------------------------------
  console.log("\n[2/6] Share / clipboard fallback...");

  let nativeCalls = 0;
  const nativeOutcome = await shareInvitation(
    { url: "https://x/y" },
    {
      share: async () => {
        nativeCalls++;
      },
    }
  );
  assert(nativeOutcome.method === "native" && nativeCalls === 1, "native share sheet is preferred when available");

  const abortOutcome = await shareInvitation(
    { url: "https://x/y" },
    {
      share: async () => {
        const err: any = new Error("cancelled");
        err.name = "AbortError";
        throw err;
      },
      clipboard: {
        writeText: async () => {
          throw new Error("should not be called");
        },
      },
    }
  );
  assert(abortOutcome.method === "cancelled", "user-cancelled share is not treated as a clipboard copy");

  const fallbackOutcome = await shareInvitation(
    { url: "https://x/y" },
    {
      share: async () => {
        throw new Error("share failed");
      },
      clipboard: { writeText: async () => undefined },
    }
  );
  assert(fallbackOutcome.method === "clipboard", "native share failure falls back to the clipboard");

  const manualOutcome = await shareInvitation(
    { url: "https://x/y" },
    {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }
  );
  assert(manualOutcome.method === "manual", "clipboard failure degrades to a manual copy");

  assert(
    (await copyToClipboard("abc", { clipboard: { writeText: async () => undefined } })) === true,
    "copyToClipboard reports success"
  );
  assert(
    (await copyToClipboard("abc", {})) === false,
    "copyToClipboard reports failure when no clipboard is available"
  );

  // -------------------------------------------------------------
  // 3. In-memory call registry
  // -------------------------------------------------------------
  console.log("\n[3/6] In-memory call registry...");

  const registry = new CallRegistry();
  registry.upsert({ sessionId: "s1", productId: "shopify-service-profile", createdAt: 1000, status: "created" });
  registry.upsert({ sessionId: "s2", productId: "clipping-service-profile", createdAt: 2000, status: "created" });

  assert(registry.size === 2, "registry tracks both sessions");
  assert(registry.list()[0].sessionId === "s2", "registry lists newest first");
  assert(registry.setStatus("s1", "live")?.status === "live", "registry updates status");
  assert(registry.get("s1")?.status === "live", "registry returns the updated record");
  assert(registry.remove("s2") === true && registry.size === 1, "registry removes a record");
  registry.clear();
  assert(registry.size === 0, "registry clears all records");

  const record = new CallRegistry().upsert({
    sessionId: "s3",
    productId: "p",
    createdAt: 1,
    status: "created",
  });
  const serialized = JSON.stringify(record);
  assert(!/stok_|inviteToken|sessionToken|token/i.test(serialized), "call records contain no tokens or secrets");

  // -------------------------------------------------------------
  // 4. Hash route parsing
  // -------------------------------------------------------------
  console.log("\n[4/6] Hash route parsing...");

  assert(parseRoute("") === DEFAULT_ROUTE, "empty hash falls back to the dashboard route");
  assert(parseRoute("#/new-call") === "new-call", "parses the new-call route");
  assert(parseRoute("#/live-room") === "live-room", "parses the live-room route");
  assert(parseRoute("#/history") === "history", "parses the history route");
  assert(parseRoute("#/profiles") === "profiles", "parses the profiles route");
  assert(parseRoute("#/settings") === "settings", "parses the settings route");
  assert(parseRoute("#/not-a-route") === DEFAULT_ROUTE, "unknown routes fall back to the dashboard");
  assert(parseRoute("#/new-call?x=1") === "new-call", "ignores a query suffix in the hash");

  // -------------------------------------------------------------
  // 5. API client contracts (mocked fetch)
  // -------------------------------------------------------------
  console.log("\n[5/6] API client contracts...");

  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (String(input).startsWith("/api/sessions?") && (!init || init.method === undefined)) {
      return new Response(
        JSON.stringify({
          sessions: [
            { id: "sess_1", productId: "p", roomName: "r", createdAt: 1, lastActivityAt: 2, historyCount: 3 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (String(input) === "/api/sessions" && init?.method === "POST") {
      const body = String(init?.body || "");
      if (!body.includes('"productId":"p"')) {
        return new Response(JSON.stringify({ error: "Valid registered productId is required.", code: "INVALID_PRODUCT" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          sessionId: "sess_1",
          sessionToken: "stok_abc",
          inviteToken: "tok_abc",
          productId: "p",
          roomName: "r",
          createdAt: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ error: "Nope", code: "INVALID_PRODUCT" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const created = await createSession("p");
    assert(created.sessionId === "sess_1" && created.inviteToken === "tok_abc", "createSession parses the response");
    const postCall = calls.find((c) => c.init?.method === "POST");
    assert(
      Boolean(postCall && String(postCall.init?.body).includes('"productId":"p"')),
      "createSession sends productId in the body"
    );
    assert(
      Boolean(
        postCall && (postCall.init?.headers as Record<string, string>)?.["Content-Type"] === "application/json"
      ),
      "createSession sends a JSON content type"
    );

    const summary = await getSessionSummary("sess_1", "stok_abc");
    assert(summary.sessions.length === 1, "getSessionSummary parses the sessions array");
    const getCall = calls.find((c) => c.url.startsWith("/api/sessions?"));
    assert(
      Boolean(getCall && (getCall.init?.headers as Record<string, string>)?.["x-session-token"] === "stok_abc"),
      "getSessionSummary passes the token via the x-session-token header"
    );
    assert(!getCall?.url.includes("stok_abc"), "getSessionSummary never puts the token in the URL");

    let apiError: ApiError | null = null;
    try {
      await createSession("unknown-product");
    } catch (err) {
      if (err instanceof ApiError) apiError = err;
    }
    assert(apiError?.code === "INVALID_PRODUCT", "API errors surface the Worker error code");
  } finally {
    globalThis.fetch = realFetch;
  }


  // -------------------------------------------------------------
  // 6. Worker route: GET /api/service-profiles
  // -------------------------------------------------------------
  console.log("\n[6/6] Worker route: GET /api/service-profiles...");

  const testEnv: Env = { DB: new MockD1Database(), NODE_ENV: "test" };
  const res = await worker.fetch(new Request("https://worker.local/api/service-profiles"), testEnv);
  assert(res.status === 200, "GET /api/service-profiles returns 200");
  const data = (await res.json()) as any;
  assert(Array.isArray(data.profiles) && data.profiles.length > 0, "returns a non-empty profiles array");

  const shopifyProfile = data.profiles.find((p: any) => p.id === "shopify-service-profile");
  assert(Boolean(shopifyProfile), "includes the shopify service profile");
  assert(shopifyProfile?.profileAvailable === true, "flags profile-backed adapters as available");
  assert(
    Array.isArray(shopifyProfile?.idealCustomers) && shopifyProfile.idealCustomers.length > 0,
    "exposes ideal customers"
  );
  assert(
    Array.isArray(shopifyProfile?.objections) && shopifyProfile.objections.length > 0,
    "exposes the objection playbook"
  );
  assert(
    Boolean(shopifyProfile?.offer && typeof shopifyProfile.offer.currency === "string"),
    "exposes the offer"
  );

  const raw = JSON.stringify(data);
  assert(!/api[_-]?key|secret|stok_|bearer/i.test(raw), "service-profiles response contains no credentials or tokens");

  const postRes = await worker.fetch(
    new Request("https://worker.local/api/service-profiles", { method: "POST" }),
    testEnv
  );
  assert(postRes.status === 404, "POST /api/service-profiles is not exposed");

  console.log("\n--------------------------------------------------");
  console.log(`Dashboard UI Test Summary: Passed: ${passed}, Failed: ${failed}`);
  console.log("==================================================");

  return { passed, failed };
}

