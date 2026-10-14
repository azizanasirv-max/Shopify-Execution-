/**
 * Typed client for the LBV Sales Copilot Worker API.
 *
 * These wrappers mirror the EXISTING Worker request/response contracts (see
 * worker.ts). No new backend contracts are invented here.
 *
 * SECURITY: authorization tokens are passed only in request headers or bodies,
 * never appended to URLs that could be logged by intermediaries, and never
 * written to console output or persistent browser storage.
 */

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}.`;
  let code = "REQUEST_FAILED";
  try {
    const data = (await res.json()) as { error?: string; message?: string; code?: string };
    if (data?.error) message = data.error;
    else if (data?.message) message = data.message;
    if (data?.code) code = data.code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(message, code, res.status);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* Types mirroring the Worker contracts                                */
/* ------------------------------------------------------------------ */

export interface CreatedSession {
  sessionId: string;
  sessionToken: string;
  inviteToken: string;
  productId: string;
  roomName: string;
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  productId: string;
  roomName: string;
  createdAt: number;
  lastActivityAt: number;
  historyCount: number;
  inviteToken?: string;
}

export interface AdapterSummary {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  toolsCount: number;
}

export interface BehavioralPolicy {
  id: string;
  name: string;
  description: string;
  strict: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: { type: string; properties?: Record<string, unknown>; required?: string[]; description?: string };
}

export interface AdaptersResponse {
  activeAdapter: {
    id: string;
    name: string;
    description: string;
    policies: BehavioralPolicy[];
    tools: ToolDefinition[];
  };
  availableAdapters: AdapterSummary[];
}

export interface ObjectionPlaybook {
  objection: string;
  response: string;
}

export interface ServiceProfileSummary {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  policies: BehavioralPolicy[];
  /** False for legacy adapters that do not expose a data-only profile. */
  profileAvailable: boolean;
  idealCustomers: string[];
  painPoints: string[];
  benefits: string[];
  qualificationRules: string[];
  discoveryQuestions: string[];
  objections: ObjectionPlaybook[];
  buyingSignals: string[];
  ctas: string[];
  offer: {
    pilotPrice: number | null;
    monthlyPrice: number | null;
    currency: string;
    scope: string;
    deliverables: string[];
    terms?: string;
  } | null;
  businessConstraints: {
    authorizedPrices: number[];
    disallowDiscounts: boolean;
    prohibitedClaims: string[];
    prohibitedTopics: string[];
  } | null;
  persona?: string;
  toolsCount: number;
}

export interface ServiceProfilesResponse {
  profiles: ServiceProfileSummary[];
}

export interface LiveKitStatus {
  configured: boolean;
  serverUrl: string | null;
  hasApiKey: boolean;
  hasApiSecret: boolean;
}

/* ------------------------------------------------------------------ */
/* Endpoint wrappers                                                   */
/* ------------------------------------------------------------------ */

/** POST /api/sessions — create a sales session (rate-limited by the Worker). */
export function createSession(productId: string): Promise<CreatedSession> {
  return requestJson<CreatedSession>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId }),
  });
}

/**
 * GET /api/sessions?sessionId= — token-authenticated single-session lookup.
 * The Worker intentionally forbids global enumeration across users.
 */
export function getSessionSummary(sessionId: string, sessionToken: string): Promise<{ sessions: SessionSummary[] }> {
  const params = new URLSearchParams({ sessionId });
  return requestJson<{ sessions: SessionSummary[] }>(`/api/sessions?${params.toString()}`, {
    headers: { "x-session-token": sessionToken },
  });
}

/** DELETE /api/sessions/:id — end a session and revoke its invitation. */
export function endSession(
  sessionId: string,
  sessionToken: string
): Promise<{ success: boolean; invitationRevoked: boolean; liveKitRoomClosed: boolean }> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { "x-session-token": sessionToken },
  });
}

/** GET /api/engine/adapters — registered product adapters + active adapter. */
export function getAdapters(productId?: string): Promise<AdaptersResponse> {
  const query = productId ? `?productId=${encodeURIComponent(productId)}` : "";
  return requestJson<AdaptersResponse>(`/api/engine/adapters${query}`);
}

/** GET /api/service-profiles — data-only service profiles (read-only, no secrets). */
export function getServiceProfiles(): Promise<ServiceProfilesResponse> {
  return requestJson<ServiceProfilesResponse>("/api/service-profiles");
}

/** GET /api/livekit/status — whether LiveKit Cloud credentials are configured. */
export function getLiveKitStatus(): Promise<LiveKitStatus> {
  return requestJson<LiveKitStatus>("/api/livekit/status");
}
