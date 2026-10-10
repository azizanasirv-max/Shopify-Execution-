/**
 * Session Manager for LBV Sales Engine
 *
 * Implements isolated, product-bound session management to guarantee:
 * 1. Conversation and business context are isolated per request/session.
 * 2. A session created for one product (e.g. Shopify) cannot switch to another product (e.g. Ghostwriter).
 * 3. Concurrent requests cannot overwrite each other's conversation history.
 * 4. Automatic session expiration (TTL cleanup) and safe thread isolation.
 */

import { SalesSession, ConversationTurn } from "./types.js";
import { AdapterRegistry } from "./adapter-registry.js";
import crypto from "crypto";

export class SessionNotFoundError extends Error {
  public readonly code = "SESSION_NOT_FOUND";
  constructor(public readonly sessionId: string) {
    super(`Sales session not found or expired: '${sessionId}'`);
    this.name = "SessionNotFoundError";
  }
}

export class MismatchedSessionProductError extends Error {
  public readonly code = "MISMATCHED_SESSION_PRODUCT";
  constructor(
    public readonly sessionId: string,
    public readonly sessionProduct: string,
    public readonly requestedProduct: string
  ) {
    super(
      `Session '${sessionId}' is bound to product '${sessionProduct}' and cannot be used with product '${requestedProduct}'. Cross-product session switching is rejected.`
    );
    this.name = "MismatchedSessionProductError";
  }
}

export class UnauthorizedSessionAccessError extends Error {
  public readonly code = "UNAUTHORIZED_SESSION_ACCESS";
  constructor(public readonly sessionId: string, message?: string) {
    super(
      message ||
        `Unauthorized access to sales session '${sessionId}'. Valid session authorization token is required.`
    );
    this.name = "UnauthorizedSessionAccessError";
  }
}

export class SessionExpiredError extends Error {
  public readonly code = "SESSION_EXPIRED";
  constructor(public readonly sessionId: string) {
    super(`Sales session '${sessionId}' has expired due to inactivity.`);
    this.name = "SessionExpiredError";
  }
}

export interface SessionManagerOptions {
  ttlMs?: number;
}

export class SessionManager {
  private sessions = new Map<string, SalesSession>();
  private readonly ttlMs: number;

  constructor(options?: SessionManagerOptions) {
    // Default TTL: 1 hour of inactivity
    this.ttlMs = options?.ttlMs ?? 60 * 60 * 1000;
  }

  /**
   * Create a new isolated sales session strictly bound to a canonical product identifier.
   * Generates a cryptographically strong session authorization token and trusted room name.
   */
  public createSession(
    canonicalProductId: string,
    metadata: Record<string, any> = {},
    explicitId?: string,
    explicitAuthToken?: string
  ): SalesSession {
    if (!canonicalProductId || typeof canonicalProductId !== "string") {
      throw new Error("Cannot create session without a valid canonicalProductId.");
    }

    const id = explicitId || `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const authToken = explicitAuthToken || `stok_${crypto.randomBytes(24).toString("hex")}`;
    const roomName = `room_${canonicalProductId}_${id}`;

    const session: SalesSession = {
      id,
      authToken,
      productId: canonicalProductId,
      roomName,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      conversationHistory: [],
      metadata: { ...metadata }
    };

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Retrieve an active session by ID.
   * Returns undefined if non-existent or expired.
   */
  public getSession(sessionId: string): SalesSession | undefined {
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // Verify TTL
    if (Date.now() - session.lastActivityAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  /**
   * Lookup session by authorization token (used for token-bound operations).
   */
  public findSessionByToken(token: string): SalesSession | undefined {
    if (!token) return undefined;
    for (const session of this.sessions.values()) {
      if (session.authToken === token) {
        if (Date.now() - session.lastActivityAt > this.ttlMs) {
          this.sessions.delete(session.id);
          return undefined;
        }
        return session;
      }
    }
    return undefined;
  }

  /**
   * Validates that the caller has authorization to access the specified session.
   * Fails closed if session does not exist, is expired, or token does not match.
   */
  public validateSessionAuthorization(
    sessionId: string,
    providedAuthToken?: string
  ): SalesSession {
    if (!sessionId) {
      throw new SessionNotFoundError("undefined");
    }
    const session = this.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    if (!providedAuthToken || providedAuthToken.trim() !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }

    session.lastActivityAt = Date.now();
    return session;
  }

  /**
   * Validates that a session exists and belongs to the requested product.
   * Throws SessionNotFoundError or MismatchedSessionProductError.
   */
  public validateSessionProduct(
    sessionId: string,
    requestedProductId: string,
    registry?: AdapterRegistry
  ): SalesSession {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // Resolve canonical requested ID if registry is provided
    const targetCanonicalId = registry
      ? registry.getCanonicalId(requestedProductId) || requestedProductId
      : requestedProductId;

    const sessionCanonicalId = registry
      ? registry.getCanonicalId(session.productId) || session.productId
      : session.productId;

    if (sessionCanonicalId !== targetCanonicalId) {
      throw new MismatchedSessionProductError(sessionId, session.productId, requestedProductId);
    }

    session.lastActivityAt = Date.now();
    return session;
  }

  /**
   * Append a turn to the session's isolated conversation history.
   * If providedAuthToken is passed, validates authorization first.
   */
  public addTurn(sessionId: string, turn: ConversationTurn, providedAuthToken?: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    if (providedAuthToken !== undefined && providedAuthToken !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }
    session.conversationHistory.push(turn);
    session.lastActivityAt = Date.now();
  }

  /**
   * Reset/clear the conversation history of a specific session without changing its product binding.
   * If providedAuthToken is passed, enforces authorization.
   */
  public clearSession(sessionId: string, providedAuthToken?: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    if (providedAuthToken !== undefined && providedAuthToken !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }
    session.conversationHistory = [];
    session.lastActivityAt = Date.now();
  }

  /**
   * Delete an active session.
   */
  public deleteSession(sessionId: string, providedAuthToken?: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;
    if (providedAuthToken !== undefined && providedAuthToken !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }
    return this.sessions.delete(sessionId);
  }

  /**
   * Active session count (for telemetry/metrics).
   */
  public getActiveSessionCount(): number {
    return this.sessions.size;
  }
}
