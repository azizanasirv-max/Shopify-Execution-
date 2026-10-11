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
import { AdapterRegistry } from "./lbv-sales-copilot/engine/adapter-registry.js";
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
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
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

  // 2. Authoritative Session Store Selection (D1 authoritative, zero fallback in production)
  let sessionStore: SessionStore;
  const isProd =
    env.NODE_ENV === "production" ||
    (!env.NODE_ENV && typeof process !== "undefined" && process.env?.NODE_ENV === "production") ||
    (!env.NODE_ENV && typeof process === "undefined"); // Fail closed in Worker environment if NODE_ENV is unspecified

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

  // 3. Model Provider
  const apiKey = env.GEMINI_API_KEY || (typeof process !== "undefined" ? process.env.GEMINI_API_KEY : "") || "";
  const modelProvider: ModelProvider = apiKey
    ? new GeminiWorkerModelProvider(apiKey)
    : {
        generateContent: async () => {
          throw new Error("GEMINI_API_KEY is not configured in Worker environment.");
        }
      };

  // 4. Generic Sales Engine
  const salesEngine = new GenericSalesEngine({
    modelProvider,
    modelName: "gemini-3.1-flash-lite",
    defaultAdapter: shopifyAdapter,
    adapterRegistry
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
    realtimeAdapter
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
  const isProd =
    env.NODE_ENV === "production" ||
    (!env.NODE_ENV && typeof process !== "undefined" && process.env?.NODE_ENV === "production") ||
    (!env.NODE_ENV && typeof process === "undefined"); // Fail closed in Worker environment if NODE_ENV is unspecified
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
    "Access-Control-Max-Age": "86400"
  };
}

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
        const body = (await request.json().catch(() => null)) as any;
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
          session = await sessionManager.createSessionAsync(targetAdapter.id);
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
        const body = (await request.json().catch(() => ({}))) as any;
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
        const body = (await request.json().catch(() => ({}))) as any;
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
        const session = await sessionManager.createSessionAsync(adapter.id);

        return jsonResponse(
          {
            sessionId: session.id,
            sessionToken: session.authToken,
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
                historyCount: authorizedSession.conversationHistory.length
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
        const body = (await request.json().catch(() => ({}))) as any;
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
          const deleted = await sessionManager.deleteSessionAsync(sessionId, token);
          if (!deleted) {
            return errorResponse("Session not found or expired.", "SESSION_NOT_FOUND", 404, corsHeaders);
          }
          return jsonResponse({ success: true, message: `Session ${sessionId} deleted.` }, 200, corsHeaders);
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
        const body = (await request.json().catch(() => ({}))) as any;
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
      // ROUTE: POST /api/livekit/transcript
      // =========================================================================
      if (pathname === "/api/livekit/transcript" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as any;
        const { sessionId, sessionToken, text, isFinal, speaker } = body;
        const tokenHeader =
          request.headers.get("x-session-token") ||
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
          sessionToken;

        if (!sessionId || typeof sessionId !== "string") {
          return errorResponse("sessionId is required for transcript ingress.", "SESSION_REQUIRED", 400, corsHeaders);
        }

        const session = await sessionManager.getSessionAsync(sessionId);
        if (!session) {
          return errorResponse("Sales session not found or expired.", "SESSION_NOT_FOUND", 404, corsHeaders);
        }

        if (!tokenHeader || tokenHeader !== session.authToken) {
          return errorResponse("Unauthorized access: Valid session authorization token is required.", "UNAUTHORIZED_SESSION_ACCESS", 403, corsHeaders);
        }

        // Defect A1 & A2: Strict boolean isFinal check (reject missing, null, string, or false values)
        if (typeof isFinal !== "boolean" || isFinal !== true) {
          return errorResponse("isFinal must be an explicit boolean true value for recommendation generation.", "INVALID_FINAL_STATUS", 400, corsHeaders);
        }

        // Defect A3: Speaker must be strictly 'prospect' or 'salesperson' (do not default unknown speakers)
        if (speaker !== "prospect" && speaker !== "salesperson") {
          return errorResponse("Invalid speaker value. Speaker must be strictly 'prospect' or 'salesperson'.", "INVALID_SPEAKER", 400, corsHeaders);
        }

        // Defect A4: Validate text length and format (non-empty string <= 4000 characters)
        if (!text || typeof text !== "string" || !text.trim()) {
          return errorResponse("Non-empty transcript text is required.", "INVALID_TRANSCRIPT", 400, corsHeaders);
        }
        if (text.length > 4000) {
          return errorResponse("Transcript text exceeds maximum allowed length of 4000 characters.", "TRANSCRIPT_TOO_LONG", 400, corsHeaders);
        }

        const targetAdapter = adapterRegistry.resolve(session.productId);
        const transcriptSpeaker = speaker;
        const finalFlag = isFinal === true;

        let recommendation: any = null;

        if (transcriptSpeaker === "prospect" && finalFlag) {
          const rawRec = await salesEngine.generateRecommendation(text.trim(), {
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
        if (env.NODE_ENV === "production") {
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
      // Static Assets (Cloudflare Pages / Worker Assets fallback)
      // =========================================================================
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return await env.ASSETS.fetch(request);
      }

      return errorResponse(`Not Found: ${pathname}`, "NOT_FOUND", 404, corsHeaders);
    } catch (err: any) {
      console.error("[Worker Uncaught Error]", err);
      return errorResponse(
        "An unexpected internal error occurred while processing the request.",
        "INTERNAL_SERVER_ERROR",
        500,
        corsHeaders
      );
    }
  }
};
