/**
 * LiveKit Realtime Adapter for Generic Sales Engine
 *
 * Integrates the generic engine with LiveKit Cloud.
 *
 * Requirements:
 * - Must support a silent copilot that displays text recommendations without publishing AI audio.
 * - Manages participant token generation and role grants.
 * - Reserved identity 'lbv-ai' for silent sales assistant.
 * - Translates incoming realtime events into GenericSalesEngine recommendations.
 * - Broadcasts recommendations as text/data payloads only (NO AI voice/audio track).
 */

import { AccessToken } from "livekit-server-sdk";
import { GenericSalesEngine } from "./generic-sales-engine.js";
import { AdapterRegistry } from "./adapter-registry.js";
import {
  RealtimeAdapterConfig,
  RealtimeCopilotMessage,
  SalesRecommendation,
  SalesSession
} from "./types.js";
import { MismatchedSessionProductError } from "./session-manager.js";

export class ReservedIdentityError extends Error {
  public readonly code = "RESERVED_IDENTITY";
  constructor(public readonly identity: string) {
    super(
      `Identity '${identity}' is reserved for future silent sales assistant participant ('lbv-ai') and cannot be claimed by clients.`
    );
    this.name = "ReservedIdentityError";
  }
}

export class UnauthorizedRoomAccessError extends Error {
  public readonly code = "ARBITRARY_ROOM_REJECTED";
  constructor(public readonly requestedRoom: string, public readonly sessionRoom: string) {
    super(
      `Arbitrary room name '${requestedRoom}' rejected. Room is strictly bound to authorized session ('${sessionRoom}').`
    );
    this.name = "UnauthorizedRoomAccessError";
  }
}

export class PermissionElevationError extends Error {
  public readonly code = "PERMISSION_ELEVATION_DENIED";
  constructor(message?: string) {
    super(
      message ||
        "Client-specified permission elevation is forbidden. Permissions are strictly server-governed."
    );
    this.name = "PermissionElevationError";
  }
}

export class SessionRequiredForLiveKitError extends Error {
  public readonly code = "SESSION_REQUIRED";
  constructor() {
    super("A valid, authorized sales session is required to issue a LiveKit token.");
    this.name = "SessionRequiredForLiveKitError";
  }
}

export interface ParticipantTokenRequest {
  session: SalesSession;
  identity: string;
  displayName?: string;
  clientRoomName?: string;
  requestedPermissions?: Record<string, any>;
  requestedProductId?: string;
  forceSimulated?: boolean;
}

export interface ParticipantTokenResponse {
  token: string;
  serverUrl: string;
  roomName: string;
  identity: string;
  mode: "real" | "simulated";
  expiresIn: number;
}

export class LiveKitRealtimeAdapter {
  private engine: GenericSalesEngine;
  private registry?: AdapterRegistry;
  private serverUrl: string | null;
  private apiKey: string | null;
  private apiSecret: string | null;

  constructor(
    engine: GenericSalesEngine,
    registry?: AdapterRegistry,
    livekitConfig?: { serverUrl?: string; apiKey?: string; apiSecret?: string }
  ) {
    this.engine = engine;
    this.registry = registry;
    this.serverUrl =
      livekitConfig?.serverUrl ||
      (typeof process !== "undefined" ? process.env?.LIVEKIT_URL : undefined) ||
      null;
    this.apiKey =
      livekitConfig?.apiKey ||
      (typeof process !== "undefined" ? process.env?.LIVEKIT_API_KEY : undefined) ||
      null;
    this.apiSecret =
      livekitConfig?.apiSecret ||
      (typeof process !== "undefined" ? process.env?.LIVEKIT_API_SECRET : undefined) ||
      null;
  }

  /**
   * Checks if LiveKit server environment variables are configured
   */
  public isConfigured(): boolean {
    return Boolean(
      this.serverUrl &&
      this.apiKey &&
      this.apiSecret &&
      !this.apiKey.includes("MY_") &&
      !this.apiSecret.includes("MY_")
    );
  }

  public getStatus() {
    return {
      configured: this.isConfigured(),
      serverUrl: this.serverUrl,
      hasApiKey: Boolean(this.apiKey && !this.apiKey.includes("MY_")),
      hasApiSecret: Boolean(this.apiSecret && !this.apiSecret.includes("MY_")),
      simulatedModeAvailable: true
    };
  }

  /**
   * Generates a short-lived token for human participants (prospect, salesperson)
   * or future silent AI copilot ('lbv-ai').
   * Supports both hardened request object (with session verification) and legacy signature.
   */
  public async createParticipantToken(
    paramsOrRoomName: ParticipantTokenRequest | string,
    identityLegacy?: string,
    displayNameLegacy?: string
  ): Promise<ParticipantTokenResponse> {
    if (typeof paramsOrRoomName === "string") {
      // Legacy signature for backward compatibility
      const roomName = paramsOrRoomName;
      const identity = identityLegacy || "prospect";
      const displayName = displayNameLegacy;

      if (identity === "lbv-ai") {
        throw new ReservedIdentityError(identity);
      }

      if (!this.isConfigured()) {
        const simPayload = { room: roomName, identity, simulated: true };
        return {
          token: `sim_token_${Buffer.from(JSON.stringify(simPayload)).toString("base64url")}`,
          serverUrl: "wss://simulated.livekit.local",
          roomName,
          identity,
          mode: "simulated",
          expiresIn: 3600
        };
      }

      const at = new AccessToken(this.apiKey!, this.apiSecret!, {
        identity,
        name: displayName || identity,
        ttl: "1h"
      });
      at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canPublishData: true,
        canSubscribe: true
      });
      const token = await at.toJwt();
      return {
        token,
        serverUrl: this.serverUrl!,
        roomName,
        identity,
        mode: "real",
        expiresIn: 3600
      };
    }

    // Hardened request object
    const {
      session,
      identity,
      displayName,
      clientRoomName,
      requestedPermissions,
      requestedProductId,
      forceSimulated
    } = paramsOrRoomName;

    // 1. Session check
    if (!session || !session.id) {
      throw new SessionRequiredForLiveKitError();
    }

    // 2. Product binding check
    if (requestedProductId) {
      const canonicalReq = this.registry
        ? this.registry.getCanonicalId(requestedProductId) || requestedProductId
        : requestedProductId;
      const canonicalSess = this.registry
        ? this.registry.getCanonicalId(session.productId) || session.productId
        : session.productId;
      if (canonicalReq !== canonicalSess) {
        throw new MismatchedSessionProductError(session.id, session.productId, requestedProductId);
      }
    }

    // 3. Identity validation and anti-impersonation
    if (!identity || typeof identity !== "string") {
      throw new Error("Participant identity is required.");
    }
    const lowerId = identity.toLowerCase().trim();
    const reservedList = ["lbv-ai", "assistant", "system", "agent", "admin", "moderator", "bot"];
    if (reservedList.some(r => lowerId === r || lowerId.startsWith("lbv-ai"))) {
      throw new ReservedIdentityError(identity);
    }
    const isAllowedRole =
      lowerId === "prospect" ||
      lowerId === "salesperson" ||
      lowerId.startsWith("prospect_") ||
      lowerId.startsWith("salesperson_");
    if (!isAllowedRole) {
      throw new Error(
        `Invalid participant identity '${identity}'. Allowed roles are 'prospect' or 'salesperson'.`
      );
    }

    // 4. Room derivation & validation (derived strictly from server session)
    const trustedRoomName = session.roomName || `room_${session.productId}_${session.id}`;
    if (clientRoomName && clientRoomName.trim() !== trustedRoomName) {
      throw new UnauthorizedRoomAccessError(clientRoomName, trustedRoomName);
    }

    // 5. Permission elevation check
    if (requestedPermissions) {
      const forbiddenElevations = [
        "admin",
        "roomAdmin",
        "canRecord",
        "hidden",
        "recorder",
        "ingress",
        "egress",
        "canPublishVideo",
        "canPublishScreenShare"
      ];
      const hasElevation = forbiddenElevations.some(k => requestedPermissions[k] === true);
      if (
        hasElevation ||
        (typeof requestedPermissions.canPublishAudio !== "undefined" &&
          requestedPermissions.canPublishAudio !== true)
      ) {
        throw new PermissionElevationError();
      }
    }

    // 6. Token generation (Real vs Simulated)
    const isProd =
      (typeof process !== "undefined" && process.env?.NODE_ENV === "production");

    const shouldUseReal = this.isConfigured() && !forceSimulated;
    if (shouldUseReal) {
      const at = new AccessToken(this.apiKey!, this.apiSecret!, {
        identity,
        name:
          displayName ||
          (identity.startsWith("prospect") ? "Prospect User" : "Sales Representative"),
        ttl: "1h"
      });

      at.addGrant({
        roomJoin: true,
        room: trustedRoomName,
        canPublish: true, // Human participant voice
        canPublishData: true,
        canSubscribe: true
      });

      const token = await at.toJwt();
      return {
        token,
        serverUrl: this.serverUrl!,
        roomName: trustedRoomName,
        identity,
        mode: "real",
        expiresIn: 3600
      };
    } else {
      if (isProd) {
        throw new Error(
          "[Production Error] LiveKit Cloud environment configuration (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) is missing in production mode. Refusing simulated room token issuance."
        );
      }

      // Hardened simulated mode for local development and test automation
      const simPayload = {
        sub: identity,
        name:
          displayName ||
          (identity.startsWith("prospect") ? "Prospect User" : "Sales Representative"),
        room: trustedRoomName,
        grants: {
          roomJoin: true,
          room: trustedRoomName,
          canPublish: true,
          canPublishData: true,
          canSubscribe: true
        },
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        simulated: true
      };

      const simToken = `sim_jwt_${Buffer.from(JSON.stringify(simPayload)).toString("base64url")}`;
      return {
        token: simToken,
        serverUrl: "wss://simulated.livekit.local",
        roomName: trustedRoomName,
        identity,
        mode: "simulated",
        expiresIn: 3600
      };
    }
  }

  /**
   * Processes a live statement received in the sales room, runs it through
   * the GenericSalesEngine, and formats a silent recommendation payload.
   */
  public async handleLiveProspectUtterance(
    roomName: string,
    prospectUtterance: string
  ): Promise<RealtimeCopilotMessage> {
    const recommendation: SalesRecommendation = await this.engine.generateRecommendation(
      prospectUtterance
    );

    const message: RealtimeCopilotMessage = {
      type: "recommendation",
      recommendation,
      status: "ready",
      roomName,
      timestamp: Date.now()
    };

    return message;
  }
}
