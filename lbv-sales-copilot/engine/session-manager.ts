/**
 * Session Manager for LBV Sales Engine
 *
 * Implements isolated, product-bound session management to guarantee:
 * 1. Conversation and business context are isolated per request/session.
 * 2. A session created for one product cannot switch to another product.
 * 3. Concurrent requests cannot overwrite each other's conversation history (mutex/locking support).
 * 4. Automatic session expiration (TTL cleanup) and safe thread isolation.
 * 5. Support for both InMemorySessionStore and durable production storage implementations (e.g. FileSessionStore).
 */

import { SalesSession, ConversationTurn } from "./types.js";
import { AdapterRegistry } from "./adapter-registry.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";

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

/**
 * SessionStore interface abstracting session persistence storage.
 */
export interface SessionStore {
  get(sessionId: string): SalesSession | undefined;
  set(sessionId: string, session: SalesSession): void;
  delete(sessionId: string): boolean;
  values(): SalesSession[];
  clear(): void;
  size(): number;
}

/**
 * In-memory session store for local development and deterministic testing.
 */
export class InMemorySessionStore implements SessionStore {
  private store = new Map<string, SalesSession>();

  get(sessionId: string): SalesSession | undefined {
    return this.store.get(sessionId);
  }

  set(sessionId: string, session: SalesSession): void {
    this.store.set(sessionId, session);
  }

  delete(sessionId: string): boolean {
    return this.store.delete(sessionId);
  }

  values(): SalesSession[] {
    return Array.from(this.store.values());
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Durable production file-based JSON session store supporting server restarts and persistence.
 */
export class FileSessionStore implements SessionStore {
  private filePath: string;
  private memoryStore = new Map<string, SalesSession>();

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(process.env.LBV_SESSION_FILE_PATH || "./data/sessions.json");
    this.load();
  }

  private load(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.memoryStore.clear();
          for (const session of data) {
            if (session && session.id) {
              this.memoryStore.set(session.id, session);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[FileSessionStore] Failed to load sessions from ${this.filePath}:`, err);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.memoryStore.values());
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error(`[FileSessionStore] Failed to persist sessions to ${this.filePath}:`, err);
    }
  }

  get(sessionId: string): SalesSession | undefined {
    return this.memoryStore.get(sessionId);
  }

  set(sessionId: string, session: SalesSession): void {
    this.memoryStore.set(sessionId, session);
    this.persist();
  }

  delete(sessionId: string): boolean {
    const deleted = this.memoryStore.delete(sessionId);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  values(): SalesSession[] {
    return Array.from(this.memoryStore.values());
  }

  clear(): void {
    this.memoryStore.clear();
    this.persist();
  }

  size(): number {
    return this.memoryStore.size;
  }
}

export interface SessionManagerOptions {
  ttlMs?: number;
  store?: SessionStore;
}

export class SessionManager {
  private store: SessionStore;
  private readonly ttlMs: number;
  private locks = new Map<string, Promise<any>>();

  constructor(options?: SessionManagerOptions) {
    // Default TTL: 1 hour of inactivity
    this.ttlMs = options?.ttlMs ?? 60 * 60 * 1000;
    this.store = options?.store ?? new InMemorySessionStore();
  }

  public getStore(): SessionStore {
    return this.store;
  }

  /**
   * Execute an operation on a session with a per-session concurrency lock
   * to prevent race conditions and concurrent history overwrites.
   */
  public async withSessionLock<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
    const previousLock = this.locks.get(sessionId) || Promise.resolve();
    let releaseLock: () => void = () => {};
    const nextLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.locks.set(sessionId, nextLock);

    await previousLock;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (this.locks.get(sessionId) === nextLock) {
        this.locks.delete(sessionId);
      }
    }
  }

  /**
   * Create a new isolated sales session strictly bound to a canonical product identifier.
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

    this.store.set(id, session);
    return session;
  }

  /**
   * Retrieve an active session by ID.
   * Returns undefined if non-existent or expired.
   */
  public getSession(sessionId: string): SalesSession | undefined {
    if (!sessionId) return undefined;
    const session = this.store.get(sessionId);
    if (!session) return undefined;

    // Verify TTL
    if (Date.now() - session.lastActivityAt > this.ttlMs) {
      this.store.delete(sessionId);
      return undefined;
    }

    return session;
  }

  /**
   * Lookup session by authorization token (used for token-bound operations).
   */
  public findSessionByToken(token: string): SalesSession | undefined {
    if (!token) return undefined;
    const vals = this.store.values();
    const sessions = Array.isArray(vals) ? vals : [];
    for (const session of sessions) {
      if (session.authToken === token) {
        if (Date.now() - session.lastActivityAt > this.ttlMs) {
          this.store.delete(session.id);
          return undefined;
        }
        return session;
      }
    }
    return undefined;
  }

  /**
   * Validates that the caller has authorization to access the specified session.
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
    this.store.set(session.id, session);
    return session;
  }

  /**
   * Validates that a session exists and belongs to the requested product.
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
    this.store.set(session.id, session);
    return session;
  }

  /**
   * Append a turn to the session's isolated conversation history with concurrency protection.
   */
  public async addTurnAsync(
    sessionId: string,
    turn: ConversationTurn,
    providedAuthToken?: string
  ): Promise<void> {
    await this.withSessionLock(sessionId, () => {
      const session = this.getSession(sessionId);
      if (!session) {
        throw new SessionNotFoundError(sessionId);
      }
      if (providedAuthToken !== undefined && providedAuthToken !== session.authToken) {
        throw new UnauthorizedSessionAccessError(sessionId);
      }
      session.conversationHistory.push(turn);
      session.lastActivityAt = Date.now();
      this.store.set(sessionId, session);
    });
  }

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
    this.store.set(sessionId, session);
  }

  /**
   * Reset/clear conversation history of a specific session.
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
    this.store.set(sessionId, session);
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
    return this.store.delete(sessionId);
  }

  /**
   * Active session count (for telemetry/metrics).
   */
  public getActiveSessionCount(): number {
    const vals = this.store.values();
    return Array.isArray(vals) ? vals.length : 0;
  }
}
