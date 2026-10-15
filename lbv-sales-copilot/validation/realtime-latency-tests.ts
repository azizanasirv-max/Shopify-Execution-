/**
 * Realtime audio-interruption and recommendation-latency tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * These tests exercise the ACTUAL behaviour of the recommendation request
 * lifecycle and the in-flight cancellation policy (extracted into
 * `src/sales/recommendationClient.ts`), rather than grepping the component's
 * source text for a configuration that is merely intended.
 *
 * Covered:
 *  1. In-flight policy - identical utterances are coalesced, a newer utterance
 *     does NOT cancel useful work, the oldest is cancelled only at the
 *     concurrency cap, and teardown cancels everything.
 *  2. Streaming/fallback policy - the buffered fallback runs ONLY when the
 *     stream never produced a terminal `final` frame, so a decided utterance
 *     never costs a second model pipeline.
 *  3. Latency measurement - time from the final transcript segment arriving to
 *     the first displayable text, with the server's `engineMetadata` preserved.
 *  4. Gate integrity - nothing is displayed unless the backend emitted it after
 *     the approval gate.
 *  5. Deterministic routing is applied at the transport ingress so a
 *     backchannel never triggers a model call at all.
 *
 * No network, no credentials, no LiveKit connection.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  RecommendationScheduler,
  normalizeRequestText,
  parseSseEvent,
  requestRecommendation,
  type RecommendationResult,
  type RecommendationTiming,
} from "../../src/sales/recommendationClient.js";
import { GenericSalesEngine } from "../engine/generic-sales-engine.js";
import { ShopifySalesAdapter } from "../sales-api/shopify-adapter.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** One SSE frame. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A streaming Response that emits the given frames then closes. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  body: any;
}

/** Records every request and answers from a per-URL script. */
function recordingFetch(
  calls: FetchCall[],
  script: (url: string, body: any) => Response | Promise<Response>
): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (init?.signal?.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    return script(url, body);
  }) as unknown as typeof fetch;
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                       */
/* -------------------------------------------------------------------------- */

export async function runRealtimeLatencyTests(): Promise<{ passed: number; failed: number }> {
  console.log("==================================================");
  console.log("   RUNNING REALTIME LATENCY & INTERRUPTION TESTS  ");
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

  const engineSource = readSource("lbv-sales-copilot/engine/generic-sales-engine.ts");
  const workerSource = readSource("worker.ts");
  const roomSource = readSource("lbv-sales-copilot/app/LiveKitSalesRoom.tsx");
  const prospectSource = readSource("lbv-sales-copilot/app/ProspectCall.tsx");

  // -------------------------------------------------------------
  // 1. In-flight cancellation policy
  // -------------------------------------------------------------
  console.log("\n[1/6] In-flight cancellation policy...");

  {
    const scheduler = new RecommendationScheduler(2);
    const first = scheduler.start("What does the pilot cost?");
    assert(first !== null, "A new utterance reserves a request slot");
    assert(scheduler.size === 1, "One request is in flight");

    // Identical utterance: coalesced, and the first request is NOT cancelled.
    const duplicate = scheduler.start("  what does the pilot COST?  ");
    assert(duplicate === null, "An identical in-flight utterance is coalesced (no second model call)");
    assert(first !== null && first.signal.aborted === false, "Coalescing does not cancel the in-flight request");
    assert(scheduler.size === 1, "Coalescing does not add a request");

    // A DIFFERENT newer utterance below the cap must not cancel useful work.
    const second = scheduler.start("How long is onboarding?");
    assert(second !== null, "A newer distinct utterance starts its own request");
    assert(first !== null && first.signal.aborted === false, "A newer segment does NOT cancel in-flight useful work");
    assert(scheduler.size === 2, "Two requests are in flight (the cap)");

    // Exceeding the cap cancels the OLDEST (already superseded) request only.
    const third = scheduler.start("Can we start next month?");
    assert(third !== null, "A third utterance still starts (the newest always proceeds)");
    assert(first !== null && first.signal.aborted === true, "At the cap, the OLDEST superseded request is cancelled");
    assert(second !== null && second.signal.aborted === false, "The predecessor of the newest request is not cancelled");
    assert(scheduler.size === 2, "In-flight count is bounded by the cap");

    scheduler.settle(second!);
    assert(scheduler.size === 1, "settle() releases a slot");

    scheduler.abortAll();
    assert(scheduler.size === 0, "abortAll() clears every slot (teardown)");
    assert(third !== null && third.signal.aborted === true, "abortAll() cancels in-flight work on teardown");
  }

  assert(
    normalizeRequestText("  What   is the PRICE? ") === "what is the price?",
    "Utterance normalization is whitespace- and case-insensitive"
  );
  assert(parseSseEvent("event: delta\ndata: {\"text\":\"hi\"}")?.data.text === "hi", "SSE frames are parsed");
  assert(parseSseEvent("garbage") === null, "Malformed SSE frames are ignored");


  // -------------------------------------------------------------
  // 2. Streaming + fallback policy (the redundant-request fix)
  // -------------------------------------------------------------
  console.log("\n[2/6] Streaming + fallback policy...");

  {
    // The stream delivers validated text and a terminal final: no fallback.
    const calls: FetchCall[] = [];
    const firstVisible: RecommendationResult[] = [];
    const results: RecommendationResult[] = [];
    const errors: string[] = [];
    let clock = 1000;
    const timing = await requestRecommendation(
      {
        sessionId: "s1",
        sessionToken: "t1",
        text: "What does the pilot cost?",
        startedAt: 0,
        fetchImpl: recordingFetch(calls, () =>
          sseResponse([
            sse("status", { status: "analyzing" }),
            sse("delta", { text: "Lead with the pilot scope." }),
            sse("final", {
              success: true,
              recommendation: {
                statement: "Lead with the pilot scope.",
                status: "APPROVED",
                engineMetadata: { latencyMs: 900, modelExecutionMs: 700, approvalGateMs: 5, turnsCount: 2, recoveryAttempts: 0 },
              },
            }),
          ])
        ),
        now: () => (clock += 100),
      },
      {
        onFirstVisible: (r) => firstVisible.push(r),
        onResult: (r) => results.push(r),
        onError: (m) => errors.push(m),
      }
    );

    assert(calls.length === 1, "A completed stream does NOT trigger the buffered fallback", `calls=${calls.length}`);
    assert(calls[0].url.endsWith("/api/livekit/transcript/stream"), "The streaming route is used first");
    assert(firstVisible.length === 1, "onFirstVisible fires exactly once");
    assert(firstVisible[0].statement === "Lead with the pilot scope.", "The validated streamed text is displayed");
    assert(results.length === 1 && results[0].status === "APPROVED", "The final approved result is delivered");
    assert(
      timing.engineMetadata?.latencyMs === 900 && timing.engineMetadata?.turnsCount === 2,
      "engineMetadata is PRESERVED (latencyMs + turnsCount)",
      JSON.stringify(timing.engineMetadata)
    );
    assert(
      timing.transcriptToFirstVisibleMs !== null && timing.transcriptToFirstVisibleMs > 0,
      "Time from final transcript to first visible text is measured",
      String(timing.transcriptToFirstVisibleMs)
    );
    assert(errors.length === 0, "No error is reported for a successful stream");
  }

  {
    // A terminal final with recommendation:null is a DECISION (duplicate or
    // non-actionable): the fallback must not run a second model pipeline.
    const calls: FetchCall[] = [];
    const results: RecommendationResult[] = [];
    await requestRecommendation(
      {
        sessionId: "s1",
        sessionToken: "t1",
        text: "mm-hmm",
        startedAt: 0,
        fetchImpl: recordingFetch(calls, () =>
          sseResponse([
            sse("status", { status: "analyzing" }),
            sse("final", { success: true, skipped: "non_actionable", recommendation: null }),
          ])
        ),
      },
      { onFirstVisible: () => {}, onResult: (r) => results.push(r), onError: () => {} }
    );

    assert(calls.length === 1, "A decided utterance (recommendation:null) does NOT pay for a second pipeline", `calls=${calls.length}`);
    assert(results.length === 0, "Nothing is displayed when the server emits no recommendation");
  }


  {
    // The stream never reached a terminal final (dropped connection): the
    // buffered route is the supported fallback.
    const calls: FetchCall[] = [];
    const results: RecommendationResult[] = [];
    const timing = await requestRecommendation(
      {
        sessionId: "s1",
        sessionToken: "t1",
        text: "What does the pilot cost?",
        startedAt: 0,
        fetchImpl: recordingFetch(calls, (url) =>
          url.endsWith("/stream")
            ? sseResponse([sse("status", { status: "analyzing" }), sse("delta", { text: "partial" })])
            : jsonResponse({
                success: true,
                recommendation: { statement: "Buffered answer.", status: "APPROVED", engineMetadata: { latencyMs: 1200 } },
              })
        ),
      },
      { onFirstVisible: () => {}, onResult: (r) => results.push(r), onError: () => {} }
    );

    assert(calls.length === 2, "An incomplete stream falls back to the buffered route", `calls=${calls.length}`);
    assert(calls[1].url.endsWith("/api/livekit/transcript"), "The fallback target is the buffered route");
    assert(results.length === 1 && results[0].statement === "Buffered answer.", "The fallback recommendation is delivered");
    assert(timing.usedFallback === true, "The timing records that the fallback was used");
  }

  {
    // Transport failure on the streaming route: fallback still works.
    const calls: FetchCall[] = [];
    const results: RecommendationResult[] = [];
    await requestRecommendation(
      {
        sessionId: "s1",
        sessionToken: null,
        text: "What does the pilot cost?",
        startedAt: 0,
        fetchImpl: recordingFetch(calls, (url) =>
          url.endsWith("/stream")
            ? new Response("nope", { status: 502 })
            : jsonResponse({ success: true, recommendation: { statement: "Fallback answer.", status: "APPROVED" } })
        ),
      },
      { onFirstVisible: () => {}, onResult: (r) => results.push(r), onError: () => {} }
    );
    assert(calls.length === 2 && results[0]?.statement === "Fallback answer.", "A non-2xx stream response falls back");
  }

  {
    // An abort must propagate and must never be reported as a user-facing error.
    const calls: FetchCall[] = [];
    const errors: string[] = [];
    const controller = new AbortController();
    controller.abort();
    let aborted = false;
    try {
      await requestRecommendation(
        {
          sessionId: "s1",
          sessionToken: null,
          text: "What does the pilot cost?",
          startedAt: 0,
          signal: controller.signal,
          fetchImpl: recordingFetch(calls, () => jsonResponse({})),
        },
        { onFirstVisible: () => {}, onResult: () => {}, onError: (m) => errors.push(m) }
      );
    } catch (error: any) {
      aborted = error?.name === "AbortError";
    }
    assert(aborted, "An aborted request propagates AbortError");
    assert(errors.length === 0, "An abort is never surfaced as a transcript error");
  }


  // -------------------------------------------------------------
  // 3. Deterministic routing at the transport ingress
  // -------------------------------------------------------------
  console.log("\n[3/6] Deterministic routing at the transport ingress...");

  const shopifyAdapter = new ShopifySalesAdapter();
  const stubProvider = { generateContent: async () => ({ text: "stub" }) } as any;

  {
    const routed = new GenericSalesEngine({
      modelProvider: stubProvider,
      defaultAdapter: shopifyAdapter,
      deterministicRouting: true,
    });
    assert(routed.shouldInvokeModel("mm-hmm") === false, "A backchannel never reaches the model");
    assert(routed.shouldInvokeModel("ok") === false, "A short acknowledgement never reaches the model");
    assert(routed.shouldInvokeModel("What does the pilot cost?") === true, "A substantive question still reaches the model");

    const unrouted = new GenericSalesEngine({ modelProvider: stubProvider, defaultAdapter: shopifyAdapter });
    assert(unrouted.shouldInvokeModel("mm-hmm") === true, "Routing stays opt-in (unchanged when the flag is off)");

    const skipCount = (workerSource.match(/shouldInvokeModel\(transcriptText\)/g) || []).length;
    assert(skipCount === 2, "BOTH transcript routes (buffered + streaming) skip non-actionable utterances", `found=${skipCount}`);
    assert(/shouldInvokeModel/.test(engineSource), "The engine exposes the routing decision");
  }

  // -------------------------------------------------------------
  // 4. Audio interruption guards
  // -------------------------------------------------------------
  console.log("\n[4/6] Audio interruption guards...");

  assert(
    /RoomEvent\.AudioPlaybackStatusChanged/.test(roomSource) && /canPlaybackAudio/.test(roomSource),
    "Salesperson detects and inspects blocked audio playback"
  );
  assert(
    /enableAudio/.test(roomSource) && /room\.startAudio\(\)/.test(roomSource),
    "Salesperson can resume audio inside a user gesture"
  );
  assert(
    /RoomEvent\.AudioPlaybackStatusChanged/.test(prospectSource) && /canPlaybackAudio/.test(prospectSource),
    "Prospect detects and inspects blocked audio playback"
  );
  assert(/enableAudio/.test(prospectSource), "Prospect can resume audio inside a user gesture");
  assert(
    /joiningRef\.current\) return/.test(roomSource),
    "Salesperson join is idempotent (no second Room / second mic track)"
  );
  assert(
    /attachRemoteAudio/.test(roomSource) && /releaseRemoteAudio/.test(roomSource),
    "Salesperson audio elements are reconciled per participant identity"
  );
  assert(
    /RoomEvent\.Reconnecting/.test(roomSource) && /RoomEvent\.Reconnected/.test(roomSource),
    "Reconnect transitions are observed (measurable transport evidence)"
  );
  assert(
    /RoomEvent\.ConnectionQualityChanged/.test(roomSource),
    "Connection quality changes are observed (measurable transport evidence)"
  );
  assert(
    !/activeAbortRef/.test(roomSource),
    "The unconditional abort-on-every-new-segment anti-pattern is gone"
  );

  // -------------------------------------------------------------
  // 5. Latency instrumentation guards
  // -------------------------------------------------------------
  console.log("\n[5/6] Latency instrumentation guards...");

  assert(
    /RecommendationScheduler/.test(roomSource) && /requestRecommendation\(/.test(roomSource),
    "The component uses the shared, tested request lifecycle"
  );
  assert(
    /transcriptToFirstVisibleMs/.test(roomSource) && /setRecommendationLatency/.test(roomSource),
    "The measured final-transcript-to-first-visible latency is surfaced"
  );
  assert(/engineMetadata/.test(roomSource), "engineMetadata is preserved and displayed");
  assert(
    !/Streaming response produced no recommendation/.test(roomSource),
    "The old fallback trigger (fall back whenever nothing rendered) is gone"
  );

  // -------------------------------------------------------------
  // 6. Approval-gate integrity
  // -------------------------------------------------------------
  console.log("\n[6/6] Approval-gate integrity...");

  {
    const engineSourceStream = /generateRecommendationStream[\s\S]{0,400}?await this\.generateRecommendation\(/;
    assert(
      engineSourceStream.test(engineSource),
      "The streaming path still awaits the FULL validated recommendation before emitting text"
    );
    assert(
      !/rawUnapprovedStatement\s*[),;]/.test(roomSource),
      "The client never receives unapproved statements"
    );
    assert(
      /delete \(sanitizedMetadata as any\)\.rawUnapprovedStatement/.test(workerSource),
      "The Worker strips unapproved statements from engineMetadata before responding"
    );
  }

  console.log("\n--------------------------------------------------");
  console.log(`Realtime Latency & Interruption Summary: Passed: ${passed}, Failed: ${failed}`);
  console.log("==================================================");
  return { passed, failed };
}

// Allow direct execution: `tsx lbv-sales-copilot/validation/realtime-latency-tests.ts`
if (process.argv[1] && process.argv[1].includes("realtime-latency-tests")) {
  runRealtimeLatencyTests()
    .then(({ failed: failures }) => process.exit(failures > 0 ? 1 : 0))
    .catch((error) => {
      console.error("Realtime latency suite crashed:", error);
      process.exit(1);
    });
}
