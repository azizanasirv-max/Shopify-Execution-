/**
 * Live recommendation request lifecycle (streaming + fallback + cancellation).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The request lifecycle used to live inline in
 * `lbv-sales-copilot/app/LiveKitSalesRoom.tsx`. The streaming/fallback policy,
 * the in-flight cancellation policy and the latency measurement are all pure
 * control flow, so they are extracted here to be unit-testable without
 * rendering the component - the same rationale as `transcriptFilter.ts`.
 *
 * SECURITY / CORRECTNESS INVARIANTS (preserved from the original implementation)
 * - Only text the backend emitted AFTER the deterministic approval gate is ever
 *   surfaced. Raw, unvalidated model tokens are never forwarded to the caller.
 * - The caller keeps a monotonic request sequence so an out-of-order response
 *   can never be displayed; this module never decides what is "current".
 * - Cancellation is used ONLY where it is necessary:
 *     1. teardown (leave / end / unmount) - everything is cancelled;
 *     2. the oldest in-flight request when the concurrency cap is reached - its
 *        result can no longer be displayed;
 *     3. never because "a newer final segment arrived" (see
 *        {@link RecommendationScheduler}).
 */

/** Status the approval gate attached to a recommendation. */
export type RecommendationStatus = "APPROVED" | "RECOVERY_REQUIRED" | "BLOCKED";

/**
 * Server-reported latency breakdown. Preserved (not discarded) so the
 * recommendation latency can be attributed to the model pipeline vs the gate.
 */
export interface EngineMetadata {
  model?: string;
  productId?: string;
  /** Total server-side time for the recommendation. */
  latencyMs?: number;
  /** Time spent in sequential model turns. */
  modelExecutionMs?: number;
  /** Time spent in the deterministic approval gate. */
  approvalGateMs?: number;
  /** Number of sequential model turns used (1-3). */
  turnsCount?: number;
  /** Bounded-recovery attempts (0 or 1). */
  recoveryAttempts?: number;
  isFallback?: boolean;
  sessionId?: string;
  [key: string]: unknown;
}

export interface RecommendationResult {
  statement: string;
  status: RecommendationStatus;
  engineMetadata?: EngineMetadata;
}

/** Measured latency for one recommendation request. */
export interface RecommendationTiming {
  /**
   * Milliseconds from the final transcript segment arriving to the first
   * displayable text. `null` when nothing was ever displayed.
   */
  transcriptToFirstVisibleMs: number | null;
  /** Milliseconds for the whole request (stream attempt + optional fallback). */
  totalMs: number;
  /** True when the result came from the buffered fallback route. */
  usedFallback: boolean;
  /** Server-reported breakdown of the winning result, when provided. */
  engineMetadata?: EngineMetadata;
}

export interface RecommendationClientHandlers {
  /**
   * First displayable text for this request (a validated streamed chunk or the
   * final result). Called at most once per request.
   */
  onFirstVisible: (result: RecommendationResult, timing: RecommendationTiming) => void;
  /** A validated final result (may coincide with `onFirstVisible`). */
  onResult: (result: RecommendationResult, timing: RecommendationTiming) => void;
  /** A request-level failure. Aborts are never reported here. */
  onError: (message: string) => void;
}

export interface RecommendationRequest {
  sessionId: string;
  sessionToken?: string | null;
  /** The final prospect utterance to analyze. */
  text: string;
  /** Monotonic clock value captured when the final segment arrived. */
  startedAt: number;
  /** Abort signal owned by the caller (teardown or supersede). */
  signal?: AbortSignal;
  /** Injected for deterministic tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for deterministic tests. Defaults to `performance.now`. */
  now?: () => number;
}

/** Monotonic clock used for latency measurement (never wall-clock). */
export function monotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

/**
 * Minimal Server-Sent Events parser for the streaming recommendation endpoint.
 * Kept byte-for-byte compatible with the previous inline implementation.
 */
export function parseSseEvent(rawEvent: string): { event: string; data: any } | null {
  const lines = rawEvent.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return (error as any)?.name === "AbortError";
}

/** Normalizes an utterance so identical in-flight work can be coalesced. */
export function normalizeRequestText(text: string): string {
  return (text || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* In-flight policy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Bounded, newest-wins in-flight policy for recommendation requests.
 *
 * The previous implementation called `activeAbortRef.current?.abort()` on EVERY
 * new final transcript segment. That cancelled useful work unconditionally:
 * a short backchannel ("yeah", "ok") arriving while a valuable recommendation
 * was still being generated destroyed that in-flight request, so the
 * salesperson received no guidance at all for the substantive sentence.
 *
 * This scheduler cancels only where cancellation is necessary:
 *  - an identical utterance that is already in flight is COALESCED (no second
 *    model call, and no cancellation of the first);
 *  - a newer utterance never cancels an older one. The caller's monotonic
 *    sequence guard already decides which response may be displayed, so letting
 *    the older request finish costs nothing extra and can surface guidance
 *    sooner;
 *  - the OLDEST in-flight request is cancelled only when the concurrency cap is
 *    reached. Its result is already superseded, so it can never be displayed;
 *  - {@link abortAll} cancels everything on teardown (leave / end / unmount).
 */
export class RecommendationScheduler {
  /**
   * Maximum concurrent recommendation requests. Two is deliberate: the newest
   * utterance must always be processed, and keeping one predecessor in flight
   * lets an almost-complete pipeline finish instead of being thrown away.
   */
  public static readonly MAX_IN_FLIGHT = 2;

  private inFlight: Array<{ text: string; controller: AbortController }> = [];

  constructor(private readonly maxInFlight: number = RecommendationScheduler.MAX_IN_FLIGHT) {}

  /** Number of requests currently in flight. */
  public get size(): number {
    return this.inFlight.length;
  }

  /**
   * Reserve a slot for `text`.
   *
   * Returns the request's `AbortController`, or `null` when an identical
   * utterance is already in flight (the caller must not issue a second request).
   */
  public start(text: string): AbortController | null {
    const key = normalizeRequestText(text);
    if (this.inFlight.some((entry) => entry.text === key)) {
      return null;
    }
    while (this.inFlight.length >= Math.max(1, this.maxInFlight)) {
      const oldest = this.inFlight.shift();
      oldest?.controller.abort();
    }
    const controller = new AbortController();
    this.inFlight.push({ text: key, controller });
    return controller;
  }

  /** Release a slot once the request has settled (success, error or abort). */
  public settle(controller: AbortController): void {
    const index = this.inFlight.findIndex((entry) => entry.controller === controller);
    if (index >= 0) this.inFlight.splice(index, 1);
  }

  /** Cancel every in-flight request (teardown only). */
  public abortAll(): void {
    const pending = this.inFlight;
    this.inFlight = [];
    for (const entry of pending) {
      entry.controller.abort();
    }
  }
}


/* -------------------------------------------------------------------------- */
/* Request lifecycle                                                           */
/* -------------------------------------------------------------------------- */

interface StreamOutcome {
  /** A terminal `final` SSE frame was received (even with a null recommendation). */
  sawTerminalFinal: boolean;
  /** The streaming attempt failed at the transport/protocol level. */
  transportFailed: boolean;
  /** The buffered fallback route was actually used. */
  usedFallback: boolean;
  /** Latest validated text, if any. */
  result: RecommendationResult | null;
  /** Monotonic timestamp of the first displayable text, if any. */
  firstVisibleAt: number | null;
}

/**
 * Reads the SSE recommendation stream.
 *
 * The backend only emits text that has already passed the deterministic
 * approval gate, so every `delta` is safe to display.
 */
async function readRecommendationStream(
  response: Response,
  handlers: RecommendationClientHandlers,
  state: StreamOutcome,
  now: () => number,
  timing: (usedFallback: boolean) => RecommendationTiming
): Promise<void> {
  if (!response.body) {
    state.transportFailed = true;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  let done = false;
  while (!done) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";

    for (const frame of frames) {
      const parsed = parseSseEvent(frame);
      if (!parsed) continue;

      if (parsed.event === "delta") {
        if (!parsed.data?.text) continue;
        accumulated += parsed.data.text;
        state.result = { statement: accumulated, status: "APPROVED" };
        if (state.firstVisibleAt === null) {
          state.firstVisibleAt = now();
          handlers.onFirstVisible(state.result, timing(false));
        }
      } else if (parsed.event === "final") {
        state.sawTerminalFinal = true;
        const rec = parsed.data?.recommendation;
        if (rec) {
          state.result = {
            statement: rec.statement,
            status: rec.status,
            engineMetadata: rec.engineMetadata,
          };
          if (state.firstVisibleAt === null) {
            state.firstVisibleAt = now();
            handlers.onFirstVisible(state.result, timing(false));
          }
          handlers.onResult(state.result, timing(false));
        }
      } else if (parsed.event === "error") {
        throw new Error(parsed.data?.error || "Streaming recommendation failed.");
      }
    }
  }
}


/**
 * Runs one recommendation request: the SSE stream first, then the buffered
 * fallback ONLY when the stream never produced a terminal `final` frame.
 *
 * The fallback decision is the second latency fix. Previously the fallback ran
 * whenever no recommendation had been rendered yet - including when the stream
 * had already delivered a terminal `final` with `recommendation: null`
 * (a suppressed duplicate or a non-actionable utterance). That issued a second
 * full model pipeline for an utterance the server had already decided about,
 * and the server's own dedupe guard then answered it with `duplicate: true`, so
 * the salesperson saw nothing while paying for two pipelines.
 */
export async function requestRecommendation(
  req: RecommendationRequest,
  handlers: RecommendationClientHandlers
): Promise<RecommendationTiming> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const now = req.now ?? monotonicNow;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(req.sessionToken ? { "x-session-token": req.sessionToken } : {}),
  };
  const body = JSON.stringify({
    sessionId: req.sessionId,
    sessionToken: req.sessionToken,
    text: req.text,
    isFinal: true,
    speaker: "prospect",
  });

  const state: StreamOutcome = {
    sawTerminalFinal: false,
    transportFailed: false,
    usedFallback: false,
    result: null,
    firstVisibleAt: null,
  };

  const timing = (usedFallback: boolean): RecommendationTiming => ({
    transcriptToFirstVisibleMs:
      state.firstVisibleAt === null ? null : state.firstVisibleAt - req.startedAt,
    totalMs: now() - req.startedAt,
    usedFallback,
    engineMetadata: state.result?.engineMetadata,
  });

  try {
    const streamRes = await fetchImpl("/api/livekit/transcript/stream", {
      method: "POST",
      headers,
      body,
      signal: req.signal,
    });
    if (streamRes.ok) {
      await readRecommendationStream(streamRes, handlers, state, now, timing);
    } else {
      state.transportFailed = true;
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Streaming is unavailable (older backend, network error, proxy). The
    // buffered route below is the supported fallback.
    state.transportFailed = true;
  }

  if (!state.sawTerminalFinal) {
    state.usedFallback = true;
    try {
      const res = await fetchImpl("/api/livekit/transcript", {
        method: "POST",
        headers,
        body,
        signal: req.signal,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        handlers.onError(
          errData.error || errData.message || `Transcript processing failed (status ${res.status}).`
        );
      } else {
        const data = await res.json().catch(() => ({}));
        const rec = data?.recommendation;
        state.sawTerminalFinal = true;
        if (rec) {
          state.result = {
            statement: rec.statement,
            status: rec.status,
            engineMetadata: rec.engineMetadata,
          };
          if (state.firstVisibleAt === null) {
            state.firstVisibleAt = now();
            handlers.onFirstVisible(state.result, timing(true));
          }
          handlers.onResult(state.result, timing(true));
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      handlers.onError(
        "Network error while processing the transcript: " +
          ((error as any)?.message || String(error))
      );
    }
  }

  return timing(state.usedFallback);
}
