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
  get(sessionId: string): SalesSession | undefined | Promise<SalesSession | undefined>;
  set(sessionId: string, session: SalesSession): void | Promise<void>;
  delete(sessionId: string): boolean | Promise<boolean>;
  values(): SalesSession[] | Promise<SalesSession[]>;
  clear(): void | Promise<void>;
  size(): number | Promise<number>;
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
 * Durable single-instance file-based JSON session store.
 * Note: Restricted to a single server instance using a persistent filesystem.
 * Its mutex provides single-process thread isolation but does not provide cross-process
 * or multi-instance locking/consistency. Persistence errors are strictly propagated to callers.
 */
export class FileSessionStore implements SessionStore {
  private filePath: string;
  private memoryStore = new Map<string, SalesSession>();

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(process.env.LBV_SESSION_FILE_PATH || "./data/sessions.json");
    this.load();
  }

  private checkWritable(dir: string): void {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const testFile = path.join(dir, `.test-write-${crypto.randomBytes(4).toString("hex")}`);
      fs.writeFileSync(testFile, "ok", "utf-8");
      fs.unlinkSync(testFile);
    } catch (err: any) {
      throw new Error(`[FileSessionStore] Directory ${dir} is not writable or accessible: ${err.message}`);
    }
  }

  private load(): void {
    const dir = path.dirname(this.filePath);
    this.checkWritable(dir);
    if (fs.existsSync(this.filePath)) {
      try {
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
      } catch (err: any) {
        throw new Error(`[FileSessionStore] Failed to load or parse sessions from ${this.filePath}: ${err.message}`);
      }
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    this.checkWritable(dir);
    const data = Array.from(this.memoryStore.values());
    const tempPath = `${this.filePath}.tmp.${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tempPath, this.filePath);
    } catch (err: any) {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {}
      }
      throw new Error(`[FileSessionStore] Failed to atomically persist sessions to ${this.filePath}: ${err.message}`);
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

/**
 * Cloudflare-native KV Session Store for production deployments on Cloudflare Workers.
 * Provides distributed persistence across Worker instances using Cloudflare KV (LBV_SESSIONS_KV).
 * Maintains an in-memory cache synchronized with Cloudflare KV for ultra-low latency reads during the request lifecycle.
 */
export class CloudflareKVSessionStore implements SessionStore {
  private memoryStore = new Map<string, SalesSession>();
  private kvNamespace: any;
  private initialized = false;

  constructor(kvNamespace?: any) {
    this.kvNamespace = kvNamespace || (typeof globalThis !== "undefined" && (globalThis as any).LBV_SESSIONS_KV);
    if (!this.kvNamespace && process.env.NODE_ENV === "production" && process.env.LBV_SESSION_STORE === "cloudflare-kv") {
      throw new Error("[CloudflareKVSessionStore] Cloudflare KV namespace binding 'LBV_SESSIONS_KV' is required in production Cloudflare Workers mode.");
    }
  }

  public async initAsync(): Promise<void> {
    if (this.initialized) return;
    if (this.kvNamespace) {
      try {
        const listResult = await this.kvNamespace.list({ prefix: "sess_" });
        if (listResult && listResult.keys) {
          for (const keyInfo of listResult.keys) {
            const raw = await this.kvNamespace.get(keyInfo.name);
            if (raw) {
              const session = JSON.parse(raw);
              if (session && session.id) {
                this.memoryStore.set(session.id, session);
              }
            }
          }
        }
      } catch (err: any) {
        throw new Error(`[CloudflareKVSessionStore] Failed to initialize and load sessions from KV: ${err.message}`);
      }
    }
    this.initialized = true;
  }

  get(sessionId: string): SalesSession | undefined {
    return this.memoryStore.get(sessionId);
  }

  set(sessionId: string, session: SalesSession): void {
    this.memoryStore.set(sessionId, session);
    if (this.kvNamespace && typeof this.kvNamespace.put === "function") {
      const payload = JSON.stringify(session);
      this.kvNamespace.put(sessionId, payload).catch((err: any) => {
        console.error(`[CloudflareKVSessionStore] Failed to persist session ${sessionId} to KV:`, err);
      });
    }
  }

  delete(sessionId: string): boolean {
    const deleted = this.memoryStore.delete(sessionId);
    if (this.kvNamespace && typeof this.kvNamespace.delete === "function") {
      this.kvNamespace.delete(sessionId).catch((err: any) => {
        console.error(`[CloudflareKVSessionStore] Failed to delete session ${sessionId} from KV:`, err);
      });
    }
    return deleted;
  }

  values(): SalesSession[] {
    return Array.from(this.memoryStore.values());
  }

  clear(): void {
    const keys = Array.from(this.memoryStore.keys());
    this.memoryStore.clear();
    if (this.kvNamespace && typeof this.kvNamespace.delete === "function") {
      for (const key of keys) {
        this.kvNamespace.delete(key).catch(() => {});
      }
    }
  }

  size(): number {
    return this.memoryStore.size;
  }
}

/**
 * Cloudflare D1 Session Store for production deployments.
 * Implements durable, strongly-consistent SQL storage on Cloudflare D1.
 * Features:
 * - Versioned optimistic concurrency control on session mutations.
 * - Atomic multi-statement batching for turn appending and timestamp updates.
 * - Foreign-key cascading deletions.
 * - Secure session authorization token validation in SQL queries.
 * - Fail-closed error propagation with no silent fallbacks.
 */
export class CloudflareD1SessionStore implements SessionStore {
  private db: any;

  constructor(db?: any) {
    this.db = db || (typeof globalThis !== "undefined" && (globalThis as any).DB);
    if (!this.db && (process.env.NODE_ENV === "production" || process.env.LBV_SESSION_STORE === "cloudflare-d1")) {
      throw new Error("[CloudflareD1SessionStore] Cloudflare D1 database binding 'DB' is required in production mode. Refusing fallback to local memory.");
    }
  }

  private ensureDb() {
    if (!this.db) {
      throw new Error("[CloudflareD1SessionStore] Cloudflare D1 database binding 'DB' is not available.");
    }
    return this.db;
  }

  public async get(sessionId: string): Promise<SalesSession | undefined> {
    const db = this.ensureDb();
    const row = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
    if (!row) return undefined;

    const turnsRes = await db.prepare(
      "SELECT turn_index, role, text, tool_calls_json, timestamp FROM conversation_turns WHERE session_id = ? ORDER BY turn_index ASC"
    ).bind(sessionId).all();

    const conversationHistory: ConversationTurn[] = (turnsRes.results || []).map((t: any) => ({
      role: t.role,
      text: t.text || undefined,
      toolCalls: t.tool_calls_json ? JSON.parse(t.tool_calls_json) : undefined,
      timestamp: Number(t.timestamp)
    }));

    let metadata: Record<string, any> = {};
    if (row.metadata_json) {
      try {
        metadata = JSON.parse(row.metadata_json);
      } catch {}
    }

    return {
      id: row.id,
      authToken: row.auth_token,
      productId: row.product_id,
      roomName: row.room_name,
      createdAt: Number(row.created_at),
      lastActivityAt: Number(row.last_activity_at),
      conversationHistory,
      metadata,
      version: Number(row.version || 1)
    } as any;
  }

  public async set(sessionId: string, session: SalesSession, expectedVersion?: number): Promise<void> {
    const db = this.ensureDb();
    const metadataJson = JSON.stringify(session.metadata || {});

    // Check if session exists to handle optimistic concurrency
    const existing = await db.prepare("SELECT version FROM sessions WHERE id = ?").bind(sessionId).first();

    if (existing) {
      const versionToMatch =
        expectedVersion !== undefined
          ? expectedVersion
          : (typeof (session as any).version === "number"
            ? (session as any).version
            : Number(existing.version));

      const updateRes = await db.prepare(
        "UPDATE sessions SET auth_token = ?, product_id = ?, room_name = ?, last_activity_at = ?, metadata_json = ?, version = version + 1 WHERE id = ? AND version = ?"
      ).bind(
        session.authToken,
        session.productId,
        session.roomName,
        session.lastActivityAt,
        metadataJson,
        sessionId,
        versionToMatch
      ).run();

      if (updateRes.meta && updateRes.meta.changes === 0) {
        throw new Error(`[CloudflareD1SessionStore] Optimistic concurrency conflict on session '${sessionId}'. Version mismatch.`);
      }
    } else {
      await db.prepare(
        "INSERT INTO sessions (id, auth_token, product_id, room_name, created_at, last_activity_at, version, metadata_json) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
      ).bind(
        session.id,
        session.authToken,
        session.productId,
        session.roomName,
        session.createdAt,
        session.lastActivityAt,
        metadataJson
      ).run();
    }
  }

  public async delete(sessionId: string): Promise<boolean> {
    const db = this.ensureDb();
    const batch = await db.batch([
      db.prepare("DELETE FROM conversation_turns WHERE session_id = ?").bind(sessionId),
      db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId)
    ]);
    const deleteSessionRes = batch[1];
    return Boolean(deleteSessionRes.meta?.changes && deleteSessionRes.meta.changes > 0);
  }

  public async values(): Promise<SalesSession[]> {
    const db = this.ensureDb();
    const sessionsRes = await db.prepare("SELECT id FROM sessions ORDER BY created_at DESC").all();
    const ids = (sessionsRes.results || []).map((r: any) => r.id);
    const sessions: SalesSession[] = [];
    for (const id of ids) {
      const s = await this.get(id);
      if (s) sessions.push(s);
    }
    return sessions;
  }

  public async clear(): Promise<void> {
    const db = this.ensureDb();
    await db.batch([
      db.prepare("DELETE FROM conversation_turns"),
      db.prepare("DELETE FROM sessions")
    ]);
  }

  public async size(): Promise<number> {
    const db = this.ensureDb();
    const row = await db.prepare("SELECT COUNT(*) as count FROM sessions").first();
    return Number(row?.count || 0);
  }

  public async addTurnAsync(
    sessionId: string,
    turn: ConversationTurn,
    providedAuthToken?: string,
    expectedVersion?: number
  ): Promise<SalesSession> {
    const db = this.ensureDb();
    const sessionRow = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
    if (!sessionRow) {
      throw new SessionNotFoundError(sessionId);
    }

    if (providedAuthToken !== undefined && providedAuthToken !== sessionRow.auth_token) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }

    const currentVersion = Number(sessionRow.version);
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new Error(`[CloudflareD1SessionStore] Optimistic concurrency conflict on session '${sessionId}'. Version mismatch.`);
    }

    const versionToMatch = expectedVersion !== undefined ? expectedVersion : currentVersion;

    // Get current turn count for sequential indexing
    const countRow = await db.prepare("SELECT COUNT(*) as count FROM conversation_turns WHERE session_id = ?").bind(sessionId).first();
    const turnIndex = Number(countRow?.count || 0);
    const now = Date.now();
    const toolCallsJson = turn.toolCalls ? JSON.stringify(turn.toolCalls) : null;

    // Atomic batch: insert turn AND update session last_activity_at + increment version conditionally
    const batchRes = await db.batch([
      db.prepare(
        "INSERT INTO conversation_turns (session_id, turn_index, role, text, tool_calls_json, timestamp) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ? AND version = ?)"
      ).bind(sessionId, turnIndex, turn.role, turn.text || null, toolCallsJson, turn.timestamp || now, sessionId, versionToMatch),
      db.prepare(
        "UPDATE sessions SET last_activity_at = ?, version = version + 1 WHERE id = ? AND version = ?"
      ).bind(now, sessionId, versionToMatch)
    ]);

    const updateRes = batchRes[1];
    if (updateRes.meta && updateRes.meta.changes === 0) {
      throw new Error(`[CloudflareD1SessionStore] Optimistic concurrency conflict on session '${sessionId}'. Version mismatch.`);
    }

    const updated = await this.get(sessionId);
    if (!updated) throw new SessionNotFoundError(sessionId);
    return updated;
  }

  public async clearSessionAsync(sessionId: string, providedAuthToken?: string): Promise<void> {
    const db = this.ensureDb();
    const sessionRow = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first();
    if (!sessionRow) {
      throw new SessionNotFoundError(sessionId);
    }

    if (providedAuthToken !== undefined && providedAuthToken !== sessionRow.auth_token) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }

    const now = Date.now();
    const currentVersion = Number(sessionRow.version);

    await db.batch([
      db.prepare("DELETE FROM conversation_turns WHERE session_id = ?").bind(sessionId),
      db.prepare(
        "UPDATE sessions SET last_activity_at = ?, version = version + 1 WHERE id = ? AND version = ?"
      ).bind(now, sessionId, currentVersion)
    ]);
  }

  public async cleanupExpired(ttlMs: number): Promise<number> {
    const db = this.ensureDb();
    const cutoff = Date.now() - ttlMs;
    const res = await db.prepare("DELETE FROM sessions WHERE last_activity_at < ?").bind(cutoff).run();
    return Number(res.meta?.changes || 0);
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
    if (session instanceof Promise) {
      throw new Error("[SessionManager] getSession called on async store. Use getSessionAsync instead.");
    }
    if (!session) return undefined;

    // Verify TTL
    if (Date.now() - session.lastActivityAt > this.ttlMs) {
      this.store.delete(sessionId);
      return undefined;
    }

    return session;
  }

  public async getSessionAsync(sessionId: string): Promise<SalesSession | undefined> {
    if (!sessionId) return undefined;
    const raw = this.store.get(sessionId);
    const session = raw instanceof Promise ? await raw : raw;
    if (!session) return undefined;

    if (Date.now() - session.lastActivityAt > this.ttlMs) {
      const del = this.store.delete(sessionId);
      if (del instanceof Promise) await del;
      return undefined;
    }

    return session;
  }

  /**
   * Lookup session by authorization token (used for token-bound operations).
   */
  /**
   * Lookup session by authorization token (used for token-bound operations).
   */
  public findSessionByToken(token: string): SalesSession | undefined {
    if (!token) return undefined;
    const vals = this.store.values();
    if (vals instanceof Promise) return undefined;
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

  public async findSessionByTokenAsync(token: string, sessionId?: string): Promise<SalesSession | undefined> {
    if (!token) return undefined;
    if (sessionId) {
      const session = await this.getSessionAsync(sessionId);
      if (session && session.authToken === token) {
        return session;
      }
      return undefined;
    }
    const vals = this.store.values();
    const sessions = vals instanceof Promise ? await vals : (Array.isArray(vals) ? vals : []);
    for (const session of sessions) {
      if (session.authToken === token) {
        if (Date.now() - session.lastActivityAt > this.ttlMs) {
          const del = this.store.delete(session.id);
          if (del instanceof Promise) await del;
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

  public async validateSessionAuthorizationAsync(
    sessionId: string,
    providedAuthToken?: string
  ): Promise<SalesSession> {
    if (!sessionId) {
      throw new SessionNotFoundError("undefined");
    }
    const session = await this.getSessionAsync(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    if (!providedAuthToken || providedAuthToken.trim() !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }

    session.lastActivityAt = Date.now();
    const res = this.store.set(session.id, session);
    if (res instanceof Promise) await res;
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

  public async validateSessionProductAsync(
    sessionId: string,
    requestedProductId: string,
    registry?: AdapterRegistry
  ): Promise<SalesSession> {
    const session = await this.getSessionAsync(sessionId);
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
    const res = this.store.set(session.id, session);
    if (res instanceof Promise) await res;
    return session;
  }

  public async createSessionAsync(
    canonicalProductId: string,
    metadata: Record<string, any> = {},
    explicitId?: string,
    explicitAuthToken?: string
  ): Promise<SalesSession> {
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
      metadata: { ...metadata },
      version: 1
    } as any;

    const res = this.store.set(id, session);
    if (res instanceof Promise) await res;
    return session;
  }

  /**
   * Append a turn to the session's isolated conversation history with concurrency protection.
   */
  public async addTurnAsync(
    sessionId: string,
    turn: ConversationTurn,
    providedAuthToken?: string,
    expectedVersion?: number
  ): Promise<void> {
    if (this.store instanceof CloudflareD1SessionStore) {
      await this.store.addTurnAsync(sessionId, turn, providedAuthToken, expectedVersion);
      return;
    }
    if (this.store instanceof CloudflareDOSessionStore) {
      await this.store.addTurnAsync(sessionId, turn, providedAuthToken);
      return;
    }
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
  public async clearSessionAsync(sessionId: string, providedAuthToken?: string): Promise<void> {
    if (this.store instanceof CloudflareD1SessionStore) {
      await this.store.clearSessionAsync(sessionId, providedAuthToken);
      return;
    }
    const session = await this.getSessionAsync(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    if (providedAuthToken !== undefined && providedAuthToken !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }
    session.conversationHistory = [];
    session.lastActivityAt = Date.now();
    const res = this.store.set(sessionId, session);
    if (res instanceof Promise) await res;
  }

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
  public async deleteSessionAsync(sessionId: string, providedAuthToken?: string): Promise<boolean> {
    const session = await this.getSessionAsync(sessionId);
    if (!session) return false;
    if (providedAuthToken !== undefined && providedAuthToken !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }
    const res = this.store.delete(sessionId);
    return res instanceof Promise ? await res : res;
  }

  public deleteSession(sessionId: string, providedAuthToken?: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;
    if (providedAuthToken !== undefined && providedAuthToken !== session.authToken) {
      throw new UnauthorizedSessionAccessError(sessionId);
    }
    return this.store.delete(sessionId) as boolean;
  }

  /**
   * Active session count (for telemetry/metrics).
   */
  public getActiveSessionCount(): number {
    const vals = this.store.values();
    return Array.isArray(vals) ? vals.length : 0;
  }
}

/**
 * Cloudflare Durable Object for authoritative per-session coordination and serialized state transitions.
 * Guarantees zero race conditions, strong consistency, and persistent storage across distributed Worker instances.
 */
export class SessionDurableObject {
  private state: any;
  private session: SalesSession | null = null;
  private loaded = false;

  constructor(state: any, env: any) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || request.method;

    if (!this.loaded) {
      this.session = await this.state.storage.get("session") || null;
      this.loaded = true;
    }

    if (request.method === "GET" || action === "get") {
      return new Response(JSON.stringify(this.session), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.method === "POST" || action === "set" || action === "update" || action === "delete" || action === "add_turn" || action === "clear") {
      const body = request.body ? await request.json().catch(() => ({})) as any : {};
      const reqAction = body.action || action;

      if (reqAction === "delete") {
        if (this.session && this.session.authToken) {
          const token = body.providedAuthToken || body.authToken;
          if (token !== this.session.authToken) {
            return new Response(JSON.stringify({ error: "Unauthorized", code: "UNAUTHORIZED_SESSION_ACCESS" }), {
              status: 403,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
        this.session = null;
        await this.state.storage.deleteAll();
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (reqAction === "set" || body.session) {
        if (this.session && this.session.authToken) {
          const token = body.providedAuthToken || body.session?.authToken || body.authToken;
          if (token !== this.session.authToken) {
            return new Response(JSON.stringify({ error: "Unauthorized", code: "UNAUTHORIZED_SESSION_ACCESS" }), {
              status: 403,
              headers: { "Content-Type": "application/json" }
            });
          }
        }
        this.session = body.session;
        if (this.session) {
          await this.state.storage.put("session", this.session);
        } else {
          await this.state.storage.deleteAll();
        }
        return new Response(JSON.stringify({ success: true, session: this.session }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (reqAction === "add_turn") {
        if (!this.session) {
          return new Response(JSON.stringify({ error: "Session not found", code: "SESSION_NOT_FOUND" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (body.providedAuthToken !== undefined && body.providedAuthToken !== this.session.authToken) {
          return new Response(JSON.stringify({ error: "Unauthorized", code: "UNAUTHORIZED_SESSION_ACCESS" }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          });
        }
        this.session.conversationHistory.push(body.turn);
        this.session.lastActivityAt = Date.now();
        await this.state.storage.put("session", this.session);
        return new Response(JSON.stringify({ success: true, session: this.session }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      if (reqAction === "clear") {
        if (!this.session) {
          return new Response(JSON.stringify({ error: "Session not found", code: "SESSION_NOT_FOUND" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (body.providedAuthToken !== undefined && body.providedAuthToken !== this.session.authToken) {
          return new Response(JSON.stringify({ error: "Unauthorized", code: "UNAUTHORIZED_SESSION_ACCESS" }), {
            status: 403,
            headers: { "Content-Type": "application/json" }
          });
        }
        this.session.conversationHistory = [];
        this.session.lastActivityAt = Date.now();
        await this.state.storage.put("session", this.session);
        return new Response(JSON.stringify({ success: true, session: this.session }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}

/**
  * Cloudflare Durable Object Session Store for distributed production deployments.
  * Eliminates race conditions, stale cache overwrites, and process-local mutex limitations
  * by delegating authoritative session storage and execution coordination to Cloudflare Durable Objects.
  */
export class CloudflareDOSessionStore implements SessionStore {
  private durableObjectNamespace: any;

  constructor(durableObjectNamespace?: any) {
    this.durableObjectNamespace = durableObjectNamespace || (typeof globalThis !== "undefined" && (globalThis as any).SESSION_DO);
    if (!this.durableObjectNamespace && (process.env.NODE_ENV === "production" || process.env.LBV_SESSION_STORE === "cloudflare-do")) {
      throw new Error("[CloudflareDOSessionStore] Durable Object namespace binding 'SESSION_DO' is required in production Cloudflare Workers mode. Refusing fallback to local memory.");
    }
  }

  private getStub(sessionId: string) {
    if (!this.durableObjectNamespace) {
      throw new Error("[CloudflareDOSessionStore] Durable Object namespace binding 'SESSION_DO' is not available.");
    }
    const id = this.durableObjectNamespace.idFromName(sessionId);
    return this.durableObjectNamespace.get(id);
  }

  public async get(sessionId: string): Promise<SalesSession | undefined> {
    if (!this.durableObjectNamespace) {
      throw new Error("[CloudflareDOSessionStore] Durable Object namespace binding 'SESSION_DO' is required for authoritative reads.");
    }
    const stub = this.getStub(sessionId);
    const res = await stub.fetch(`https://do/session?action=get`);
    if (!res.ok) {
      throw new Error(`[CloudflareDOSessionStore] Authoritative read failed for session ${sessionId}: ${res.statusText}`);
    }
    const session = await res.json() as SalesSession | null;
    return session || undefined;
  }

  public async set(sessionId: string, session: SalesSession): Promise<void> {
    if (!this.durableObjectNamespace) {
      throw new Error("[CloudflareDOSessionStore] Durable Object namespace binding 'SESSION_DO' is required for authoritative writes.");
    }
    const stub = this.getStub(sessionId);
    const res = await stub.fetch(`https://do/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", session })
    });
    if (!res.ok) {
      throw new Error(`[CloudflareDOSessionStore] Authoritative persist failed for session ${sessionId}: ${res.statusText}`);
    }
  }

  public async delete(sessionId: string): Promise<boolean> {
    if (!this.durableObjectNamespace) {
      throw new Error("[CloudflareDOSessionStore] Durable Object namespace binding 'SESSION_DO' is required for authoritative deletions.");
    }
    const stub = this.getStub(sessionId);
    const res = await stub.fetch(`https://do/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete" })
    });
    if (!res.ok) {
      throw new Error(`[CloudflareDOSessionStore] Authoritative delete failed for session ${sessionId}: ${res.statusText}`);
    }
    const data = await res.json() as any;
    return Boolean(data && data.success);
  }

  values(): SalesSession[] {
    return [];
  }

  clear(): void {}

  size(): number {
    return 0;
  }

  public async addTurnAsync(sessionId: string, turn: ConversationTurn, providedAuthToken?: string): Promise<SalesSession> {
    if (!this.durableObjectNamespace) {
      throw new Error("[CloudflareDOSessionStore] Durable Object namespace binding 'SESSION_DO' is required.");
    }

    const stub = this.getStub(sessionId);
    const res = await stub.fetch(`https://do/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add_turn", turn, providedAuthToken })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: "DO update failed", code: "INTERNAL_ERROR" })) as any;
      if (errData.code === "SESSION_NOT_FOUND") {
        throw new SessionNotFoundError(sessionId);
      }
      if (errData.code === "UNAUTHORIZED_SESSION_ACCESS") {
        throw new UnauthorizedSessionAccessError(sessionId);
      }
      throw new Error(`[CloudflareDOSessionStore] Failed to add turn: ${errData.error || res.statusText}`);
    }

    const data = await res.json() as any;
    if (data && data.session) {
      return data.session;
    }
    throw new SessionNotFoundError(sessionId);
  }
}
