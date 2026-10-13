/**
 * Cloudflare Worker Entry Point for LBV Sales Engine
 *
 * Implements a pure Web-standard Request/Response Cloudflare Worker API.
 * Decoupled from Node.js Express.
 *
 * Architecture:
 * - Authoritative persistence on Cloudflare D1 (with Durable Object support).
 * - Generic Sales Engine with deterministic approval gate.
 * - Product adapters: Shopify and Ghostwriter.
 * - Security boundaries: Anti-impersonation, strict product binding, token authorization,
 *   payload size limits, CORS headers, sanitized error responses, and protected admin endpoints.
 */

import { GenericSalesEngine } from "./lbv-sales-copilot/engine/generic-sales-engine.js";
import { ShopifySalesAdapter } from "./lbv-sales-copilot/sales-api/shopify-adapter.js";
import { GhostwriterSalesAdapter } from "./lbv-sales-copilot/sales-api/ghostwriter-adapter.js";
import { LiveKitRealtimeAdapter } from "./lbv-sales-copilot/engine/realtime-adapter.js";
import { RoomServiceClient } from "livekit-server-sdk";
import { AdapterRegistry } from "./lbv-sales-copilot/engine/adapter-registry.js";
import { registerServiceProfiles } from "./lbv-sales-copilot/sales-api/profiles/index.js";
import {
  SessionManager,
  SessionNotFoundError,
  MismatchedSessionProductError,
  UnauthorizedSessionAccessError,
  InMemorySessionStore,
  CloudflareD1SessionStore,
  SessionStore
} from "./lbv-sales-copilot/engine/session-manager.js";
import { ModelProvider } from "./lbv-sales-copilot/engine/types.js";
import {
  createLlmProvider,
  resolveProviderId,
  LegacyModelProviderAdapter,
  TokenBudget,
  UsageTracker
} from "./lbv-sales-copilot/engine/llm/index.js";

export interface Env {
  DB?: any; // Cloudflare D1
  GEMINI_API_KEY?: string;
  ADMIN_API_KEY?: string;
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  NODE_ENV?: string;
  LBV_SESSION_STORE?: string;
  ALLOWED_ORIGINS?: string;
  // Provider-agnostic LLM configuration (Groq is the default provider).
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_TIMEOUT_MS?: string;
  GROQ_API_KEY?: string;
  /** Optional global cumulative token budget (0/unset disables enforcement). */
  LBV_MAX_TOTAL_TOKENS?: string;
  LBV_MAX_REQUEST_TOKENS?: string;
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
}

/**
 * Determine whether the worker must run in production (fail-closed) mode.
 *
 * Security rationale: Cloudflare Workers configured with the `nodejs_compat`
 * flag expose a `process` polyfill, so `typeof process` CANNOT be used to
 * distinguish a Cloudflare Worker from Node.js. The previous implementation
 * relied on it and therefore failed OPEN (enabling wildcard CORS) whenever
 * `NODE_ENV` was absent in a Worker with `process` defined.
 *
 * Policy: treat the environment as production unless it is *explicitly*
 * configured as a non-production environment (`development` or `test`).
 * This makes secure behavior the default and requires an explicit opt-in
 * for development conveniences such as wildcard CORS.
 */
export function isProductionEnvironment(env: Env): boolean {
  return env.NODE_ENV !== "development" && env.NODE_ENV !== "test";
}

/**
 * Worker-native Gemini REST Model Provider using standard fetch.
 * Guarantees zero Node.js runtime dependencies and respects request timeouts.
 */
export class GeminiWorkerModelProvider implements ModelProvider {
  private apiKey: string;
  private timeoutMs: number;

  constructor(apiKey: string, timeoutMs: number = 25000) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async generateContent(params: {
    model: string;
    contents: any[];
    config?: any;
  }): Promise<{ text?: string; functionCalls?: any[]; candidates?: any[] }> {
    const model = params.model || "gemini-3.1-flash-lite";
    // Use secure x-goog-api-key HTTP header for authentication instead of URL query parameter
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const bodyPayload: Record<string, any> = {
      contents: params.contents
    };

    if (params.config?.systemInstruction) {
      bodyPayload.systemInstruction = {
        parts: [{ text: params.config.systemInstruction }]
      };
    }

    if (params.config?.tools && Array.isArray(params.config.tools) && params.config.tools.length > 0) {
      bodyPayload.tools = params.config.tools;
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
          "User-Agent": "lbv-sales-engine-worker/1.0"
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 429) {
          throw new Error(`Gemini API Quota Exceeded (429): ${errorText}`);
        }
        throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as any;
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      let text = "";
      const functionCalls: any[] = [];

      for (const part of parts) {
        if (part.text) {
          text += part.text;
        }
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
      }

      return {
        text,
        functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        candidates: data.candidates
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`Gemini API request timed out after ${this.timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
    }
  }
}

/**
 * Creates and initializes the domain services given the runtime environment.
 */
export function createWorkerServices(env: Env) {
  // 1. Adapters and Registry
  const shopifyAdapter = new ShopifySalesAdapter();
  const ghostwriterAdapter = new GhostwriterSalesAdapter();
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(shopifyAdapter, ["shopify", "shopify-pilot", "shopify-conversion"]);
  adapterRegistry.register(ghostwriterAdapter, ["ghostwriter", "ghostwriting", "executive-ghostwriter"]);
  // Service-profile adapters (data-driven). Adding a service = adding a profile.
  registerServiceProfiles(adapterRegistry);

  // 2. Authoritative Session Store Selection (D1 authoritative, zero fallback in production)
  let sessionStore: SessionStore;
  const isProd = isProductionEnvironment(env);

  if (env.DB) {
    sessionStore = new CloudflareD1SessionStore(env.DB);
  } else if (isProd || env.LBV_SESSION_STORE === "cloudflare-d1") {
    throw new Error(
      "[Production Error] Cloudflare D1 persistent database binding 'DB' is required in production Cloudflare Workers mode. Refusing insecure fallback to memory, DO, or KV."
    );
  } else {
    sessionStore = new InMemorySessionStore();
  }

  const sessionManager = new SessionManager({ store: sessionStore });

  // 3. Model Provider (provider-agnostic; Groq is the initial/default provider)
  const providerEnv = {
    LLM_PROVIDER: env.LLM_PROVIDER,
    LLM_MODEL: env.LLM_MODEL,
    LLM_TIMEOUT_MS: env.LLM_TIMEOUT_MS,
    GROQ_API_KEY: env.GROQ_API_KEY || (typeof process !== "undefined" ? process.env.GROQ_API_KEY : undefined),
    GEMINI_API_KEY: env.GEMINI_API_KEY || (typeof process !== "undefined" ? process.env.GEMINI_API_KEY : undefined)
  };
  const llmProvider = createLlmProvider(providerEnv);
  const providerId = llmProvider ? llmProvider.id : resolveProviderId(providerEnv);
  const modelProvider: ModelProvider = llmProvider
    ? new LegacyModelProviderAdapter(llmProvider)
    : {
        generateContent: async () => {
          throw new Error(
            `LLM provider '${providerId}' is not configured. Set the corresponding API key as a Worker secret.`
          );
        }
      };

  const usageTracker = new UsageTracker();
  const maxTotalTokens = env.LBV_MAX_TOTAL_TOKENS ? parseInt(env.LBV_MAX_TOTAL_TOKENS, 10) : 0;
  const maxRequestTokens = env.LBV_MAX_REQUEST_TOKENS ? parseInt(env.LBV_MAX_REQUEST_TOKENS, 10) : 0;
  const tokenBudget = new TokenBudget({
    maxTotalTokens: Number.isFinite(maxTotalTokens) ? maxTotalTokens : 0,
    maxRequestTokens: Number.isFinite(maxRequestTokens) ? maxRequestTokens : 0
  });

  // 4. Generic Sales Engine
  const salesEngine = new GenericSalesEngine({
    modelProvider,
    modelName: env.LLM_MODEL || (llmProvider ? llmProvider.defaultModel : "llama-3.1-8b-instant"),
    defaultAdapter: shopifyAdapter,
    adapterRegistry,
    providerId,
    tokenBudget,
    usageTracker,
    deterministicRouting: true,
    conciseOutput: { enabled: true, minWords: 15, maxWords: 35 }
  });

  // 5. Realtime Adapter
  const realtimeAdapter = new LiveKitRealtimeAdapter(salesEngine, adapterRegistry, {
    serverUrl: env.LIVEKIT_URL,
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    isProd
  });

  return {
    adapterRegistry,
    shopifyAdapter,
    ghostwriterAdapter,
    sessionStore,
    sessionManager,
    salesEngine,
    realtimeAdapter,
    providerId,
    usageTracker
  };
}

// Global cached services instance in Worker isolate
let cachedEnv: Env | undefined;
let cachedServices: ReturnType<typeof createWorkerServices> | undefined;

function getServices(env: Env) {
  if (!cachedServices || cachedEnv !== env) {
    cachedServices = createWorkerServices(env);
    cachedEnv = env;
  }
  return cachedServices;
}

// Helper to construct JSON response with standard security headers
function jsonResponse(data: any, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...extraHeaders
    }
  });
}

// Helper to construct sanitized error response
function errorResponse(
  message: string,
  code: string = "INTERNAL_ERROR",
  status: number = 500,
  extraHeaders: Record<string, string> = {}
): Response {
  return jsonResponse({ error: message, code }, status, extraHeaders);
}

// Helper to handle CORS
function handleCorsHeaders(request: Request, env: Env): Record<string, string> {
  const isProd = isProductionEnvironment(env);
  const origin = request.headers.get("Origin") || "";

  // Explicit allowed origin policy in production
  const defaultAllowed = isProd ? [] : ["*"];
  const allowed = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(",").map(o => o.trim())
    : defaultAllowed;

  let allowOrigin = "null";
  if (allowed.includes("*")) {
    allowOrigin = origin || "*";
  } else if (origin && allowed.includes(origin)) {
    allowOrigin = origin;
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token, X-Session-Id, X-Admin-Token",
    "Access-Control-Max-Age": "86400",
    // Do not leak invitation/session URLs (which may contain tokens) to third
    // parties, and never cache API responses containing tokens.
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store"
  };
}

/**
 * Shared, strict validation for LiveKit transcript ingress.
 *
 * Used by BOTH the buffered and streaming transcript routes so their security
 * checks (session lookup, token auth, isFinal, speaker, text bounds) can never
 * drift apart. Returns a ready-to-send Response on failure.
 */
async function validateTranscriptIngress(
  request: Request,
  sessionManager: SessionManager,
  adapterRegistry: AdapterRegistry,
  corsHeaders: Record<string, string>
): Promise<
  | { ok: true; session: any; targetAdapter: any; text: string; speaker: string }
  | { ok: false; response: Response }
> {
  const body = (await readJsonBody(request, 65536, {})) as any;
  const { sessionId, sessionToken, text, isFinal, speaker } = body;
  const tokenHeader =
    request.headers.get("x-session-token") ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    sessionToken;

  if (!sessionId || typeof sessionId !== "string") {
    return { ok: false, response: errorResponse("sessionId is required for transcript ingress.", "SESSION_REQUIRED", 400, corsHeaders) };
  }

  const session = await sessionManager.getSessionAsync(sessionId);
  if (!session) {
    return { ok: false, response: errorResponse("Sales session not found or expired.", "SESSION_NOT_FOUND", 404, corsHeaders) };
  }

  if (!tokenHeader || tokenHeader !== session.authToken) {
    return { ok: false, response: errorResponse("Unauthorized access: Valid session authorization token is required.", "UNAUTHORIZED_SESSION_ACCESS", 403, corsHeaders) };
  }

  // Strict boolean isFinal check (reject missing, null, string, or false values)
  if (typeof isFinal !== "boolean" || isFinal !== true) {
    return { ok: false, response: errorResponse("isFinal must be an explicit boolean true value for recommendation generation.", "INVALID_FINAL_STATUS", 400, corsHeaders) };
  }

  // Speaker must be strictly 'prospect' or 'salesperson' (do not default unknown speakers)
  if (speaker !== "prospect" && speaker !== "salesperson") {
    return { ok: false, response: errorResponse("Invalid speaker value. Speaker must be strictly 'prospect' or 'salesperson'.", "INVALID_SPEAKER", 400, corsHeaders) };
  }

  if (!text || typeof text !== "string" || !text.trim()) {
    return { ok: false, response: errorResponse("Non-empty transcript text is required.", "INVALID_TRANSCRIPT", 400, corsHeaders) };
  }
  if (text.length > 4000) {
    return { ok: false, response: errorResponse("Transcript text exceeds maximum allowed length of 4000 characters.", "TRANSCRIPT_TOO_LONG", 400, corsHeaders) };
  }

  const targetAdapter = adapterRegistry.resolve(session.productId);
  return { ok: true, session, targetAdapter, text: text.trim(), speaker };
}

/**
 * Best-effort, per-isolate idempotency guard for transcript ingress.
 *
 * The browser client already de-duplicates by provider segment id, and the
 * engine de-duplicates inside handleRealtimeTranscript(), but the HTTP
 * transcript routes call the engine directly and therefore need their own
 * guard so a retried or duplicated final utterance cannot trigger a second
 * model call.
 *
 * NOTE: Cloudflare Worker isolates are ephemeral and horizontally scaled, so
 * this is defense-in-depth, not a durable exactly-once guarantee.
 */
const TRANSCRIPT_DEDUPE_WINDOW_MS = 10000;
const recentTranscriptKeys = new Map<string, number>();

function isDuplicateTranscript(sessionId: string, text: string): boolean {
  const now = Date.now();
  for (const [key, ts] of recentTranscriptKeys) {
    if (now - ts > TRANSCRIPT_DEDUPE_WINDOW_MS) recentTranscriptKeys.delete(key);
  }
  const key = `${sessionId}::${text.trim().toLowerCase()}`;
  if (recentTranscriptKeys.has(key)) return true;
  recentTranscriptKeys.set(key, now);
  return false;
}

/**
 * Length-constant string comparison for secret material (invite tokens).
 * Avoids early-exit timing differences.
 */
function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Thrown when a request body exceeds the allowed size. */
export class PayloadTooLargeError extends Error {
  public readonly code = "PAYLOAD_TOO_LARGE";
  constructor(public readonly limitBytes: number) {
    super(`Payload Too Large: maximum request size is ${Math.floor(limitBytes / 1024)}KB.`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Reads and parses a JSON request body while enforcing a hard byte cap that does
 * NOT depend on the Content-Length header (a chunked/streamed body may omit it).
 * Returns `fallback` for empty or malformed bodies, matching the previous
 * `.json().catch(...)` behaviour.
 */
async function readJsonBody(request: Request, maxBytes: number, fallback: any = {}): Promise<any> {
  const declared = request.headers.get("Content-Length");
  if (declared && parseInt(declared, 10) > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }
  if (!request.body) return fallback;
  const reader = (request.body as any).getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) throw new PayloadTooLargeError(maxBytes);
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
  } finally {
    if (typeof reader.releaseLock === "function") reader.releaseLock();
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * High-entropy invitation token. Stored server-side in the session metadata and
 * shared with the prospect via the invitation link. It grants ONLY the ability
 * to validate the invitation and obtain a prospect-scoped, audio-only room
 * token - never the salesperson session token or any recommendation data.
 */
function generateInviteToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionInviteToken(session: any): string | undefined {
  const token = session?.metadata?.inviteToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function isValidInvite(session: any, provided: unknown): boolean {
  const expected = sessionInviteToken(session);
  return Boolean(expected) && safeEqual(provided, expected);
}

/**
 * Durable session-creation guard shared by every route that can create a
 * session (POST /api/sessions AND the unauthenticated POST /api/copilot
 * fallback). Returns a 429 Response when the window limit is exceeded, or null
 * when creation may proceed.
 */
async function enforceSessionCreationLimit(
  sessionManager: SessionManager,
  corsHeaders: Record<string, string>
): Promise<Response | null> {
  const store: any = sessionManager.getStore();
  if (!store || typeof store.countSessionsCreatedSince !== "function") return null;
  try {
    const recent = await store.countSessionsCreatedSince(Date.now() - SESSION_CREATION_WINDOW_MS);
    if (recent >= SESSION_CREATION_MAX_PER_WINDOW) {
      return errorResponse(
        "Too many sessions created recently. Please retry shortly.",
        "RATE_LIMITED",
        429,
        corsHeaders
      );
    }
  } catch (limitErr) {
    // Do not block all legitimate traffic on a transient limiter error.
    console.error("[Worker] Session rate-limit check failed:", limitErr);
  }
  return null;
}

function liveKitHttpHost(serverUrl: string): string {
  return serverUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

/**
 * Terminates the LiveKit room for a session (best effort).
 *
 * Deleting the D1 session record revokes the INVITATION (no new token can be
 * issued) but does NOT invalidate an already-issued LiveKit JWT. Deleting the
 * room is what actually stops participation and prevents rejoining with a
 * previously issued token. Returns true only when the LiveKit API call succeeds.
 */
async function terminateLiveKitRoom(env: Env, roomName: string): Promise<boolean> {
  try {
    const apiKey = env.LIVEKIT_API_KEY || (typeof process !== "undefined" ? process.env.LIVEKIT_API_KEY : undefined);
    const apiSecret = env.LIVEKIT_API_SECRET || (typeof process !== "undefined" ? process.env.LIVEKIT_API_SECRET : undefined);
    const serverUrl = env.LIVEKIT_URL || (typeof process !== "undefined" ? process.env.LIVEKIT_URL : undefined);
    if (!apiKey || !apiSecret || !serverUrl || apiKey.includes("MY_") || apiSecret.includes("MY_")) {
      return false;
    }
    const roomService = new RoomServiceClient(liveKitHttpHost(serverUrl), apiKey, apiSecret);
    await roomService.deleteRoom(roomName);
    return true;
  } catch (err: any) {
    console.error("[Worker] LiveKit room teardown failed:", err?.message || err);
    return false;
  }
}

/**
 * Retention window for scheduled session cleanup.
 *
 * Sessions idle beyond the SessionManager TTL (1h) are already rejected on
 * read; this longer window is used only by the cron handler to delete stale
 * rows so the D1 tables cannot grow without bound.
 */
const SESSION_CLEANUP_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Durable session-creation limit (D1-backed, consistent across isolates).
 * This is a coarse global abuse guard; Cloudflare Rate Limiting rules remain
 * the recommended platform-level control for production traffic shaping.
 */
const SESSION_CREATION_WINDOW_MS = 60 * 1000;
const SESSION_CREATION_MAX_PER_WINDOW = 60;

export default {
  async fetch(request: Request, env: Env, ctx?: any): Promise<Response> {
    const corsHeaders = handleCorsHeaders(request, env);

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // 2. Request body size check (Reject payloads > 64KB to prevent DoS)
    const contentLength = request.headers.get("Content-Length");
    if (contentLength && parseInt(contentLength, 10) > 65536) {
      return errorResponse("Payload Too Large: maximum request size is 64KB.", "PAYLOAD_TOO_LARGE", 413, corsHeaders);
    }

    try {
      let services: ReturnType<typeof createWorkerServices>;
      try {
        services = getServices(env);
      } catch (initErr: any) {
        return errorResponse(initErr.message || "Worker initialization failed", "STARTUP_ERROR", 500, corsHeaders);
      }

      const { adapterRegistry, sessionManager, salesEngine, realtimeAdapter, shopifyAdapter } = services;

      // =========================================================================
      // ROUTE: POST /api/copilot
      // =========================================================================
      if (pathname === "/api/copilot" && request.method === "POST") {
        const body = (await readJsonBody(request, 65536, null)) as any;
        if (!body || typeof body !== "object") {
          return errorResponse("Malformed request: valid JSON body is required.", "INVALID_REQUEST", 400, corsHeaders);
        }

        const { prompt, productId, sessionId, sessionToken } = body;
        if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
          return errorResponse("Prompt is required and must be a non-empty string.", "INVALID_PROMPT", 400, corsHeaders);
        }
        if (prompt.length > 4000) {
          return errorResponse("Prompt exceeds maximum allowed length of 4000 characters.", "PROMPT_TOO_LONG", 400, corsHeaders);
        }

        const tokenHeader =
          request.headers.get("x-session-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
          sessionToken;

        let targetProductId = productId;
        let session = sessionId ? await sessionManager.getSessionAsync(sessionId) : undefined;

        if (sessionId && !session) {
          return errorResponse(`Session '${sessionId}' not found or expired.`, "SESSION_NOT_FOUND", 404, corsHeaders);
        }

        if (session) {
          if (!tokenHeader || tokenHeader !== session.authToken) {
            return errorResponse(
              `Unauthorized access: Valid session authorization token is required for session '${sessionId}'.`,
              "UNAUTHORIZED_SESSION_ACCESS",
              403,
              corsHeaders
            );
          }

          if (targetProductId) {
            try {
              await sessionManager.validateSessionProductAsync(session.id, targetProductId, adapterRegistry);
            } catch (mismatchErr: any) {
              return errorResponse(mismatchErr.message, "MISMATCHED_SESSION_PRODUCT", 400, corsHeaders);
            }
          } else {
            targetProductId = session.productId;
          }
        }

        if (!targetProductId) {
          return errorResponse(
            "Product identifier ('productId') or valid 'sessionId' is required to resolve product adapter. Silent fallback is prohibited.",
            "MISSING_PRODUCT_ID",
            400,
            corsHeaders
          );
        }

        if (!adapterRegistry.has(targetProductId)) {
          return errorResponse(
            `Unknown product identifier: '${targetProductId}'. Must be an approved registered adapter.`,
            "UNKNOWN_PRODUCT",
            400,
            corsHeaders
          );
        }

        const targetAdapter = adapterRegistry.resolve(targetProductId);

        if (!session) {
          // This route is unauthenticated and can create a session, so it must
          // honour the same durable creation limit as POST /api/sessions.
          const copilotLimit = await enforceSessionCreationLimit(sessionManager, corsHeaders);
          if (copilotLimit) return copilotLimit;
          session = await sessionManager.createSessionAsync(targetAdapter.id, { inviteToken: generateInviteToken() });
        }

        const recommendation = await salesEngine.generateRecommendation(prompt, {
          adapter: targetAdapter,
          session,
          history: session.conversationHistory
        });

        // Ensure new conversation turns created in-memory during recommendation generation are atomically persisted back to D1 / store
        if (session.conversationHistory.length >= 2) {
          const lastModelTurn = session.conversationHistory[session.conversationHistory.length - 1];
          const lastUserTurn = session.conversationHistory[session.conversationHistory.length - 2];
          if (lastUserTurn && lastModelTurn && lastUserTurn.role === "user" && lastModelTurn.role === "model") {
            try {
              await sessionManager.addTurnsAtomicAsync(session.id, [lastUserTurn, lastModelTurn], session.authToken);
            } catch (persistErr: any) {
              console.error("[Worker] D1 Turn atomic persistence error:", persistErr);
              return errorResponse("Failed to persist session conversation turn.", "PERSISTENCE_ERROR", 500, corsHeaders);
            }
          }
        }

        // Sanitize recommendation before returning in public response:
        // Raw unapproved text (rawUnapprovedStatement) must never be leaked in engineMetadata or public JSON
        const sanitizedEngineMetadata = recommendation.engineMetadata ? { ...recommendation.engineMetadata } : {};
        delete (sanitizedEngineMetadata as any).rawUnapprovedStatement;

        return jsonResponse(
          {
            answer: recommendation.statement,
            status: recommendation.status,
            sessionId: session.id,
            sessionToken: session.authToken,
            roomName: session.roomName,
            productId: targetAdapter.id,
            toolsUsed: recommendation.toolsUsed,
            validationReport: recommendation.validationReport,
            engineMetadata: sanitizedEngineMetadata
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: GET /api/engine/adapters
      // =========================================================================
      if (pathname === "/api/engine/adapters" && request.method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        const productId = url.searchParams.get("productId");
        let activeAdapter = shopifyAdapter;

        if (sessionId) {
          const session = await sessionManager.getSessionAsync(sessionId);
          if (session && adapterRegistry.has(session.productId)) {
            activeAdapter = adapterRegistry.resolve(session.productId) as any;
          }
        } else if (productId && adapterRegistry.has(productId)) {
          activeAdapter = adapterRegistry.resolve(productId) as any;
        }

        return jsonResponse(
          {
            activeAdapter: {
              id: activeAdapter.id,
              name: activeAdapter.name,
              description: activeAdapter.description,
              policies: activeAdapter.getBehavioralPolicies(),
              tools: activeAdapter.getTools()
            },
            availableAdapters: adapterRegistry.getSummaries()
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: POST /api/engine/adapters/switch
      // =========================================================================
      if (pathname === "/api/engine/adapters/switch" && request.method === "POST") {
        const body = (await readJsonBody(request, 65536, {})) as any;
        const { adapterId } = body;
        if (!adapterId || typeof adapterId !== "string") {
          return errorResponse("adapterId is required.", "INVALID_ADAPTER_ID", 400, corsHeaders);
        }

        if (!adapterRegistry.has(adapterId)) {
          return errorResponse(
            `Unknown product identifier: '${adapterId}'. Cannot switch to unknown product.`,
            "UNKNOWN_PRODUCT",
            400,
            corsHeaders
          );
        }

        const targetAdapter = adapterRegistry.resolve(adapterId);
        const newSession = await sessionManager.createSessionAsync(targetAdapter.id);

        return jsonResponse(
          {
            success: true,
            sessionId: newSession.id,
            sessionToken: newSession.authToken,
            roomName: newSession.roomName,
            activeAdapter: {
              id: targetAdapter.id,
              name: targetAdapter.name,
              description: targetAdapter.description,
              policies: targetAdapter.getBehavioralPolicies(),
              tools: targetAdapter.getTools()
            }
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: POST /api/sessions (Create Session)
      // =========================================================================
      if (pathname === "/api/sessions" && request.method === "POST") {
        const body = (await readJsonBody(request, 65536, {})) as any;
        const { productId } = body;
        if (!productId || !adapterRegistry.has(productId)) {
          return errorResponse(
            `Valid registered productId is required. Received: '${productId}'.`,
            "INVALID_PRODUCT",
            400,
            corsHeaders
          );
        }

        const adapter = adapterRegistry.resolve(productId);

        // Durable abuse guard: bound how many sessions can be created per window.
        const createLimit = await enforceSessionCreationLimit(sessionManager, corsHeaders);
        if (createLimit) return createLimit;

        const inviteToken = generateInviteToken();
        const session = await sessionManager.createSessionAsync(adapter.id, { inviteToken });

        // `inviteToken` is returned ONLY to the creator (salesperson). It must
        // never be included in prospect-facing responses.
        return jsonResponse(
          {
            sessionId: session.id,
            sessionToken: session.authToken,
            inviteToken,
            productId: session.productId,
            roomName: session.roomName,
            createdAt: session.createdAt
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: GET /api/sessions (Token-authenticated Session Listing)
      // =========================================================================
      if (pathname === "/api/sessions" && request.method === "GET") {
        const token =
          request.headers.get("x-session-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
          url.searchParams.get("sessionToken");
        const sessionId = url.searchParams.get("sessionId") || request.headers.get("x-session-id") || undefined;

        if (!token) {
          return errorResponse(
            "Authentication required. Global session enumeration across multiple users is prohibited.",
            "GLOBAL_LISTING_FORBIDDEN",
            401,
            corsHeaders
          );
        }

        const authorizedSession = await sessionManager.findSessionByTokenAsync(token, sessionId);
        if (!authorizedSession) {
          return errorResponse(
            "Invalid session authorization token. No matching session found.",
            "UNAUTHORIZED_SESSION_ACCESS",
            401,
            corsHeaders
          );
        }

        return jsonResponse(
          {
            sessions: [
              {
                id: authorizedSession.id,
                productId: authorizedSession.productId,
                roomName: authorizedSession.roomName,
                createdAt: authorizedSession.createdAt,
                lastActivityAt: authorizedSession.lastActivityAt,
                historyCount: authorizedSession.conversationHistory.length,
                // Returned ONLY to the authenticated session owner (salesperson)
                // so the invitation link can be recovered after a reload.
                inviteToken: sessionInviteToken(authorizedSession)
              }
            ]
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: GET /api/sessions/:id
      // =========================================================================
      if (pathname.startsWith("/api/sessions/") && !pathname.endsWith("/clear") && request.method === "GET") {
        const sessionId = pathname.replace("/api/sessions/", "");
        const token =
          request.headers.get("x-session-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
          url.searchParams.get("sessionToken");

        const session = await sessionManager.getSessionAsync(sessionId);
        if (!session) {
          return errorResponse("Session not found or expired.", "SESSION_NOT_FOUND", 404, corsHeaders);
        }

        if (!token || token !== session.authToken) {
          return errorResponse(
            "Unauthorized access: Valid session authorization token is required to inspect this session.",
            "UNAUTHORIZED_SESSION_ACCESS",
            403,
            corsHeaders
          );
        }

        return jsonResponse(
          {
            id: session.id,
            productId: session.productId,
            roomName: session.roomName,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt,
            historyCount: session.conversationHistory.length,
            conversationHistory: session.conversationHistory
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: POST /api/sessions/:id/clear
      // =========================================================================
      if (pathname.startsWith("/api/sessions/") && pathname.endsWith("/clear") && request.method === "POST") {
        const sessionId = pathname.replace("/api/sessions/", "").replace("/clear", "");
        const body = (await readJsonBody(request, 65536, {})) as any;
        const token =
          request.headers.get("x-session-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
          body?.sessionToken;

        if (!token) {
          return errorResponse("Unauthorized access: Valid session authorization token is required to clear a session.", "UNAUTHORIZED_SESSION_ACCESS", 403, corsHeaders);
        }

        try {
          await sessionManager.clearSessionAsync(sessionId, token);
          return jsonResponse({ success: true, message: `Session ${sessionId} history cleared.` }, 200, corsHeaders);
        } catch (err: any) {
          if (err instanceof SessionNotFoundError || err.code === "SESSION_NOT_FOUND") {
            return errorResponse(err.message, "SESSION_NOT_FOUND", 404, corsHeaders);
          }
          if (err instanceof UnauthorizedSessionAccessError || err.code === "UNAUTHORIZED_SESSION_ACCESS") {
            return errorResponse(err.message, "UNAUTHORIZED_SESSION_ACCESS", 403, corsHeaders);
          }
          return errorResponse(err.message || "Failed to clear session", "INTERNAL_ERROR", 500, corsHeaders);
        }
      }

      // =========================================================================
      // ROUTE: DELETE /api/sessions/:id
      // =========================================================================
      if (pathname.startsWith("/api/sessions/") && request.method === "DELETE") {
        const sessionId = pathname.replace("/api/sessions/", "");
        const token =
          request.headers.get("x-session-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

        if (!token) {
          return errorResponse("Unauthorized access: Valid session authorization token is required to delete a session.", "UNAUTHORIZED_SESSION_ACCESS", 403, corsHeaders);
        }

        try {
          // Capture the room name BEFORE deletion so we can tear the room down.
          const sessionBeforeDelete = await sessionManager.getSessionAsync(sessionId);
          const roomNameToClose = sessionBeforeDelete?.roomName;

          const deleted = await sessionManager.deleteSessionAsync(sessionId, token);
          if (!deleted) {
            return errorResponse("Session not found or expired.", "SESSION_NOT_FOUND", 404, corsHeaders);
          }

          // Revoke live access: deleting the D1 record revokes the invitation but
          // not already-issued JWTs, so the room is deleted explicitly.
          const roomClosed = roomNameToClose ? await terminateLiveKitRoom(env, roomNameToClose) : false;

          return jsonResponse(
            {
              success: true,
              message: `Session ${sessionId} deleted.`,
              invitationRevoked: true,
              liveKitRoomClosed: roomClosed
            },
            200,
            corsHeaders
          );
        } catch (err: any) {
          if (err instanceof UnauthorizedSessionAccessError || err.code === "UNAUTHORIZED_SESSION_ACCESS") {
            return errorResponse(err.message, "UNAUTHORIZED_SESSION_ACCESS", 403, corsHeaders);
          }
          return errorResponse(err.message || "Failed to delete session", "INTERNAL_ERROR", 500, corsHeaders);
        }
      }

      // =========================================================================
      // ROUTE: POST /api/livekit/token
      // =========================================================================
      if (pathname === "/api/livekit/token" && request.method === "POST") {
        const body = (await readJsonBody(request, 65536, {})) as any;
        const { sessionId, sessionToken, productId, roomName, identity, name, permissions, grants } = body;
        const tokenHeader =
          request.headers.get("x-session-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
          sessionToken;

        if (!sessionId || typeof sessionId !== "string") {
          return errorResponse("sessionId is required to request a LiveKit token.", "SESSION_REQUIRED", 400, corsHeaders);
        }

        const session = await sessionManager.getSessionAsync(sessionId);
        if (!session) {
          return errorResponse("Sales session not found or expired.", "SESSION_NOT_FOUND", 404, corsHeaders);
        }

        if (!tokenHeader || tokenHeader !== session.authToken) {
          return errorResponse("Unauthorized access: Valid session authorization token is required.", "UNAUTHORIZED_SESSION_ACCESS", 403, corsHeaders);
        }

        if (productId && typeof productId === "string") {
          const canonicalReq = adapterRegistry.getCanonicalId(productId) || productId;
          const canonicalSess = adapterRegistry.getCanonicalId(session.productId) || session.productId;
          if (canonicalReq !== canonicalSess) {
            return errorResponse(
              `Session '${session.id}' is bound to product '${session.productId}' and cannot receive a LiveKit token for product '${productId}'. Cross-product LiveKit access is rejected.`,
              "MISMATCHED_SESSION_PRODUCT",
              400,
              corsHeaders
            );
          }
        }

        const trustedRoom = session.roomName || `room_${session.productId}_${session.id}`;
        if (roomName && roomName.trim() !== trustedRoom) {
          return errorResponse(
            `Arbitrary room name '${roomName}' is rejected. Room is strictly bound to authorized session ('${trustedRoom}').`,
            "ARBITRARY_ROOM_REJECTED",
            403,
            corsHeaders
          );
        }

        if (!identity || typeof identity !== "string") {
          return errorResponse("Participant identity is required ('prospect' or 'salesperson').", "INVALID_IDENTITY", 400, corsHeaders);
        }

        const lowerId = identity.toLowerCase().trim();
        if (
          lowerId === "lbv-ai" ||
          lowerId.includes("lbv-ai") ||
          ["system", "admin", "assistant", "agent"].includes(lowerId)
        ) {
          return errorResponse(
            `Identity '${identity}' is reserved for future silent sales assistant participant ('lbv-ai'). Impersonation is rejected.`,
            "RESERVED_IDENTITY",
            403,
            corsHeaders
          );
        }

        if (
          lowerId !== "prospect" &&
          lowerId !== "salesperson" &&
          !lowerId.startsWith("prospect_") &&
          !lowerId.startsWith("salesperson_")
        ) {
          return errorResponse(`Invalid participant identity '${identity}'. Allowed roles are 'prospect' or 'salesperson'.`, "INVALID_IDENTITY", 400, corsHeaders);
        }

        if (permissions || grants) {
          return errorResponse(
            "Client cannot elevate its own LiveKit room permissions. Role permissions are strictly server-governed.",
            "PERMISSION_ELEVATION_DENIED",
            403,
            corsHeaders
          );
        }

        const tokenData = await realtimeAdapter.createParticipantToken({
          session,
          identity,
          displayName: name,
          clientRoomName: roomName,
          requestedPermissions: permissions,
          requestedProductId: productId
        });

        return jsonResponse(tokenData, 200, corsHeaders);
      }

      // =========================================================================
      // ROUTE: GET /api/livekit/invite (public invitation validation)
      //
      // Lets the prospect page validate an invitation link WITHOUT exposing any
      // private data (no session auth token, no recommendations, no prompts).
      // =========================================================================
      if (pathname === "/api/livekit/invite" && request.method === "GET") {
        const inviteSessionId = url.searchParams.get("sessionId") || "";
        const inviteTokenParam = url.searchParams.get("token") || "";

        if (!inviteSessionId || !inviteTokenParam) {
          return errorResponse("A valid invitation requires a sessionId and token.", "INVALID_INVITATION", 400, corsHeaders);
        }

        const inviteSession = await sessionManager.getSessionAsync(inviteSessionId);
        if (!inviteSession) {
          return errorResponse("This invitation is invalid or has expired.", "INVITATION_NOT_FOUND", 404, corsHeaders);
        }

        if (!isValidInvite(inviteSession, inviteTokenParam)) {
          return errorResponse("This invitation is invalid or has expired.", "INVALID_INVITATION", 403, corsHeaders);
        }

        const inviteAdapter = adapterRegistry.has(inviteSession.productId)
          ? adapterRegistry.resolve(inviteSession.productId)
          : undefined;

        return jsonResponse(
          {
            valid: true,
            sessionId: inviteSession.id,
            status: "ready",
            productName: inviteAdapter ? inviteAdapter.name : undefined,
            livekitConfigured: realtimeAdapter.isConfigured()
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: POST /api/livekit/invite-token (prospect-only, audio-only token)
      //
      // Issues a least-privilege LiveKit token for the prospect identified by a
      // valid invitation. The identity is FIXED to "prospect" and video sources
      // are not granted; clients cannot request the salesperson identity or
      // elevate permissions.
      // =========================================================================
      if (pathname === "/api/livekit/invite-token" && request.method === "POST") {
        const inviteBody = (await readJsonBody(request, 65536, {})) as any;
        const inviteSessionId = inviteBody?.sessionId;
        const inviteTokenParam = inviteBody?.inviteToken;
        const inviteDisplayName = inviteBody?.displayName;

        if (!inviteSessionId || typeof inviteSessionId !== "string" || !inviteTokenParam || typeof inviteTokenParam !== "string") {
          return errorResponse("A valid invitation requires a sessionId and token.", "INVALID_INVITATION", 400, corsHeaders);
        }

        const inviteSession = await sessionManager.getSessionAsync(inviteSessionId);
        if (!inviteSession) {
          return errorResponse("This invitation is invalid or has expired.", "INVITATION_NOT_FOUND", 404, corsHeaders);
        }

        if (!isValidInvite(inviteSession, inviteTokenParam)) {
          return errorResponse("This invitation is invalid or has expired.", "INVALID_INVITATION", 403, corsHeaders);
        }

        try {
          const prospectToken = await realtimeAdapter.createParticipantToken({
            session: inviteSession,
            identity: "prospect",
            displayName:
              typeof inviteDisplayName === "string" && inviteDisplayName.trim()
                ? inviteDisplayName.trim().slice(0, 60)
                : "Prospect",
            audioOnly: true
          });
          return jsonResponse({ ...prospectToken, sessionId: inviteSession.id }, 200, corsHeaders);
        } catch (inviteErr: any) {
          return errorResponse(
            inviteErr?.message || "Failed to issue a prospect token for this invitation.",
            "TOKEN_ISSUE_FAILED",
            500,
            corsHeaders
          );
        }
      }

      // =========================================================================
      // ROUTE: POST /api/livekit/transcript
      // =========================================================================
      if (pathname === "/api/livekit/transcript" && request.method === "POST") {
        const ingress = await validateTranscriptIngress(request, sessionManager, adapterRegistry, corsHeaders);
        if (!ingress.ok) return ingress.response;
        const { session, targetAdapter, text: transcriptText, speaker: transcriptSpeaker } = ingress;
        const finalFlag = true;

        let recommendation: any = null;

        if (transcriptSpeaker === "prospect" && finalFlag) {
          if (isDuplicateTranscript(session.id, transcriptText)) {
            return jsonResponse(
              {
                success: true,
                sessionId: session.id,
                productId: session.productId,
                speaker: transcriptSpeaker,
                duplicate: true,
                recommendation: null
              },
              200,
              corsHeaders
            );
          }

          const rawRec = await salesEngine.generateRecommendation(transcriptText, {
            adapter: targetAdapter,
            session,
            history: session.conversationHistory
          });

          // Explicitly persist new turns atomically to session store / D1
          if (session.conversationHistory.length >= 2) {
            const lastModelTurn = session.conversationHistory[session.conversationHistory.length - 1];
            const lastUserTurn = session.conversationHistory[session.conversationHistory.length - 2];
            if (lastUserTurn && lastModelTurn && lastUserTurn.role === "user" && lastModelTurn.role === "model") {
              try {
                await sessionManager.addTurnsAtomicAsync(session.id, [lastUserTurn, lastModelTurn], session.authToken);
              } catch (persistErr: any) {
                console.error("[Worker Realtime] Atomic persistence error:", persistErr);
                return errorResponse("Failed to persist session conversation turn.", "PERSISTENCE_ERROR", 500, corsHeaders);
              }
            }
          }

          const sanitizedMetadata = rawRec.engineMetadata ? { ...rawRec.engineMetadata } : {};
          delete (sanitizedMetadata as any).rawUnapprovedStatement;

          recommendation = {
            statement: rawRec.statement,
            status: rawRec.status,
            toolsUsed: rawRec.toolsUsed,
            validationReport: rawRec.validationReport,
            engineMetadata: sanitizedMetadata
          };
        }

        return jsonResponse(
          {
            success: true,
            sessionId: session.id,
            productId: session.productId,
            speaker: transcriptSpeaker,
            recommendation
          },
          200,
          corsHeaders
        );
      }

      // =========================================================================
      // ROUTE: POST /api/livekit/transcript/stream (Server-Sent Events)
      //
      // Streams a recommendation incrementally to the "SAY THIS NEXT" panel.
      // SECURITY: only VALIDATED text is emitted - the engine runs the
      // deterministic approval gate first and the raw model tokens are never
      // forwarded. The buffered route above remains the non-streaming fallback.
      // =========================================================================
      if (pathname === "/api/livekit/transcript/stream" && request.method === "POST") {
        const ingress = await validateTranscriptIngress(request, sessionManager, adapterRegistry, corsHeaders);
        if (!ingress.ok) return ingress.response;
        const { session, targetAdapter, text: transcriptText, speaker: transcriptSpeaker } = ingress;

        const encoder = new TextEncoder();
        const sseHeaders: Record<string, string> = {
          ...corsHeaders,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        };

        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: any) => {
              controller.enqueue(encoder.encode(`event: ${event}
data: ${JSON.stringify(data)}

`));
            };
            try {
              if (transcriptSpeaker !== "prospect") {
                send("final", {
                  success: true,
                  sessionId: session.id,
                  productId: session.productId,
                  speaker: transcriptSpeaker,
                  recommendation: null
                });
                return;
              }

              if (isDuplicateTranscript(session.id, transcriptText)) {
                send("final", {
                  success: true,
                  sessionId: session.id,
                  productId: session.productId,
                  speaker: transcriptSpeaker,
                  duplicate: true,
                  recommendation: null
                });
                return;
              }

              send("status", { status: "analyzing" });

              const rawRec = await salesEngine.generateRecommendationStream(
                transcriptText,
                { adapter: targetAdapter, session, history: session.conversationHistory },
                (delta) => send("delta", { text: delta })
              );

              // Persist new turns atomically (identical contract to the buffered route)
              if (session.conversationHistory.length >= 2) {
                const lastModelTurn = session.conversationHistory[session.conversationHistory.length - 1];
                const lastUserTurn = session.conversationHistory[session.conversationHistory.length - 2];
                if (lastUserTurn && lastModelTurn && lastUserTurn.role === "user" && lastModelTurn.role === "model") {
                  await sessionManager.addTurnsAtomicAsync(session.id, [lastUserTurn, lastModelTurn], session.authToken);
                }
              }

              const sanitizedMetadata = rawRec.engineMetadata ? { ...rawRec.engineMetadata } : {};
              delete (sanitizedMetadata as any).rawUnapprovedStatement;

              send("final", {
                success: true,
                sessionId: session.id,
                productId: session.productId,
                speaker: transcriptSpeaker,
                recommendation: {
                  statement: rawRec.statement,
                  status: rawRec.status,
                  toolsUsed: rawRec.toolsUsed,
                  validationReport: rawRec.validationReport,
                  engineMetadata: sanitizedMetadata
                }
              });
            } catch (streamErr: any) {
              console.error("[Worker Realtime Stream] error:", streamErr);
              send("error", { error: streamErr?.message || "Streaming recommendation failed." });
            } finally {
              controller.close();
            }
          }
        });

        return new Response(stream, { status: 200, headers: sseHeaders });
      }

      // =========================================================================
      // ROUTE: GET /api/livekit/status
      // =========================================================================
      if (pathname === "/api/livekit/status" && request.method === "GET") {
        return jsonResponse(realtimeAdapter.getStatus(), 200, corsHeaders);
      }

      // =========================================================================
      // ROUTE: Protected Admin Test Endpoints (Disabled in production)
      // =========================================================================
      if (
        pathname === "/api/run-adversarial-tests" ||
        pathname === "/api/run-stage2-validation" ||
        pathname === "/api/save-baseline" ||
        pathname === "/api/load-baseline"
      ) {
        if (isProductionEnvironment(env)) {
          return errorResponse(
            "Internal test and evaluation endpoints are disabled in production.",
            "ENDPOINT_DISABLED_IN_PRODUCTION",
            404,
            corsHeaders
          );
        }

        const adminToken =
          request.headers.get("x-admin-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

        const expectedAdminKey = env.ADMIN_API_KEY;
        if (!expectedAdminKey || adminToken !== expectedAdminKey) {
          return errorResponse(
            "Forbidden: Internal validation and test endpoints require explicit admin authorization.",
            "ADMIN_AUTHORIZATION_REQUIRED",
            403,
            corsHeaders
          );
        }
      }

      // =========================================================================
      // Static Assets (Cloudflare Workers Static Assets via the ASSETS binding)
      //
      // Every /api/* route is handled above and never reaches this point, so
      // static asset handling cannot interfere with API routes. Non-asset
      // requests are delegated to the asset binding, which applies
      // `not_found_handling = "single-page-application"`. A defensive
      // index.html fallback is added for GET/HEAD navigations.
      // =========================================================================
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        const assetResponse = await env.ASSETS.fetch(request);
        if (assetResponse.status !== 404) {
          return assetResponse;
        }
        if ((request.method === "GET" || request.method === "HEAD") && !pathname.startsWith("/api/")) {
          const indexRequest = new Request(new URL("/index.html", request.url).toString(), { method: "GET" });
          const indexResponse = await env.ASSETS.fetch(indexRequest);
          if (indexResponse.status !== 404) {
            return indexResponse;
          }
        }
        return errorResponse(`Not Found: ${pathname}`, "NOT_FOUND", 404, corsHeaders);
      }

      return errorResponse(`Not Found: ${pathname}`, "NOT_FOUND", 404, corsHeaders);
    } catch (err: any) {
      if (err?.code === "PAYLOAD_TOO_LARGE") {
        return errorResponse(
          err.message || "Payload Too Large: maximum request size is 64KB.",
          "PAYLOAD_TOO_LARGE",
          413,
          corsHeaders
        );
      }
      console.error("[Worker Uncaught Error]", err);
      return errorResponse(
        "An unexpected internal error occurred while processing the request.",
        "INTERNAL_SERVER_ERROR",
        500,
        corsHeaders
      );
    }
  },

  /**
   * Cron handler (configured via [triggers] in wrangler.toml).
   *
   * Best-effort cleanup of sessions (and, via ON DELETE CASCADE, their
   * conversation turns) that have been idle beyond the retention window.
   * Failures are logged and never thrown, so a cleanup error cannot take the
   * Worker down.
   */
  async scheduled(_controller: any, env: Env, _ctx?: any): Promise<void> {
    try {
      const services = getServices(env);
      const store: any = services.sessionStore;
      if (store && typeof store.cleanupExpired === "function") {
        const removed = await store.cleanupExpired(SESSION_CLEANUP_RETENTION_MS);
        console.log(`[Worker Scheduled] Removed ${removed} expired session(s).`);
      }
    } catch (err: any) {
      console.error("[Worker Scheduled] Session cleanup failed:", err?.message || err);
    }
  }
};
