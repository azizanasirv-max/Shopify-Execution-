/**
 * Test Suite for Cloudflare D1 Persistent Session Storage
 *
 * Verifies:
 * 1. D1 schema conformance and table structure.
 * 2. Asynchronous persistence and retrieval of sessions.
 * 3. Durable conversation history updates with atomic batching.
 * 4. Optimistic concurrency control and protection against lost writes.
 * 5. Session authorization validation on all mutations.
 * 6. Session TTL expiration and SQL cleanup.
 * 7. Error propagation on database failures without silent memory fallback.
 */

import {
  CloudflareD1SessionStore,
  SessionManager,
  SessionNotFoundError,
  UnauthorizedSessionAccessError
} from "../engine/session-manager.js";
import { ConversationTurn, SalesSession } from "../engine/types.js";

/**
 * Realistic in-memory Cloudflare D1 engine for deterministic local testing.
 * Implements D1Database interface (prepare, bind, first, all, run, batch).
 */
export class MockD1Database {
  public sessions = new Map<string, any>();
  public turns: any[] = [];
  public shouldFail = false;

  prepare(sql: string) {
    return new MockD1PreparedStatement(this, sql);
  }

  async batch(statements: MockD1PreparedStatement[]) {
    if (this.shouldFail) {
      throw new Error("D1 Error: Database disk I/O failure during batch execution");
    }
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }
}

export class MockD1PreparedStatement {
  private db: MockD1Database;
  private sql: string;
  private params: any[] = [];

  constructor(db: MockD1Database, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: any[]) {
    this.params = args;
    return this;
  }

  async first<T = any>(col?: string): Promise<T | null> {
    const res = await this.all<T>();
    if (!res.results || res.results.length === 0) return null;
    const row = res.results[0] as any;
    return col ? row[col] : row;
  }

  async all<T = any>(): Promise<{ results: T[]; success: boolean; meta: any }> {
    if (this.db.shouldFail) {
      throw new Error("D1 Error: Database query failure");
    }

    const trimmed = this.sql.trim();

    if (trimmed.startsWith("SELECT * FROM sessions WHERE id = ?")) {
      const id = this.params[0];
      const s = this.db.sessions.get(id);
      return { results: s ? [s as any] : [], success: true, meta: {} };
    }

    if (trimmed.startsWith("SELECT version FROM sessions WHERE id = ?")) {
      const id = this.params[0];
      const s = this.db.sessions.get(id);
      return { results: s ? [{ version: s.version } as any] : [], success: true, meta: {} };
    }

    if (trimmed.startsWith("SELECT COUNT(*) as count FROM sessions")) {
      return { results: [{ count: this.db.sessions.size } as any], success: true, meta: {} };
    }

    if (trimmed.startsWith("SELECT id FROM sessions ORDER BY created_at DESC")) {
      const rows = Array.from(this.db.sessions.values()).map(s => ({ id: s.id }));
      return { results: rows as any, success: true, meta: {} };
    }

    if (trimmed.includes("FROM conversation_turns WHERE session_id = ?")) {
      const sessionId = this.params[0];
      if (trimmed.startsWith("SELECT COUNT(*) as count")) {
        const count = this.db.turns.filter(t => t.session_id === sessionId).length;
        return { results: [{ count } as any], success: true, meta: {} };
      }
      const turns = this.db.turns
        .filter(t => t.session_id === sessionId)
        .sort((a, b) => a.turn_index - b.turn_index);
      return { results: turns as any, success: true, meta: {} };
    }

    return { results: [], success: true, meta: {} };
  }

  async run(): Promise<{ success: boolean; meta: any }> {
    if (this.db.shouldFail) {
      throw new Error("D1 Error: Statement execution failure");
    }

    const trimmed = this.sql.trim();

    if (trimmed.startsWith("INSERT INTO sessions")) {
      const [id, auth_token, product_id, room_name, created_at, last_activity_at, metadata_json] = this.params;
      this.db.sessions.set(id, {
        id,
        auth_token,
        product_id,
        room_name,
        created_at,
        last_activity_at,
        version: 1,
        metadata_json
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("UPDATE sessions SET auth_token = ?")) {
      const [auth_token, product_id, room_name, last_activity_at, metadata_json, id, expectedVersion] = this.params;
      const s = this.db.sessions.get(id);
      if (!s || s.version !== expectedVersion) {
        return { success: true, meta: { changes: 0 } };
      }
      s.auth_token = auth_token;
      s.product_id = product_id;
      s.room_name = room_name;
      s.last_activity_at = last_activity_at;
      s.metadata_json = metadata_json;
      s.version = s.version + 1;
      return { success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("UPDATE sessions SET last_activity_at = ?, version = version + 1 WHERE id = ? AND version = ?")) {
      const [last_activity_at, id, expectedVersion] = this.params;
      const s = this.db.sessions.get(id);
      if (!s || s.version !== expectedVersion) {
        return { success: true, meta: { changes: 0 } };
      }
      s.last_activity_at = last_activity_at;
      s.version = s.version + 1;
      return { success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("INSERT INTO conversation_turns")) {
      if (trimmed.includes("WHERE EXISTS")) {
        const [session_id, turn_index, role, text, tool_calls_json, timestamp, checkId, checkVersion] = this.params;
        const s = this.db.sessions.get(checkId);
        if (!s || s.version !== checkVersion) {
          return { success: true, meta: { changes: 0 } };
        }
        this.db.turns.push({
          session_id,
          turn_index,
          role,
          text,
          tool_calls_json,
          timestamp
        });
        return { success: true, meta: { changes: 1 } };
      }
      const [session_id, turn_index, role, text, tool_calls_json, timestamp] = this.params;
      this.db.turns.push({
        session_id,
        turn_index,
        role,
        text,
        tool_calls_json,
        timestamp
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("DELETE FROM conversation_turns WHERE session_id = ?")) {
      const sessionId = this.params[0];
      const initial = this.db.turns.length;
      this.db.turns = this.db.turns.filter(t => t.session_id !== sessionId);
      return { success: true, meta: { changes: initial - this.db.turns.length } };
    }

    if (trimmed.startsWith("DELETE FROM sessions WHERE id = ?")) {
      const id = this.params[0];
      const deleted = this.db.sessions.delete(id);
      return { success: true, meta: { changes: deleted ? 1 : 0 } };
    }

    if (trimmed.startsWith("DELETE FROM sessions WHERE last_activity_at < ?")) {
      const cutoff = this.params[0];
      let changes = 0;
      for (const [id, s] of Array.from(this.db.sessions.entries())) {
        if (s.last_activity_at < cutoff) {
          this.db.sessions.delete(id);
          this.db.turns = this.db.turns.filter(t => t.session_id !== id);
          changes++;
        }
      }
      return { success: true, meta: { changes } };
    }

    if (trimmed.startsWith("DELETE FROM conversation_turns") && !trimmed.includes("WHERE")) {
      this.db.turns = [];
      return { success: true, meta: { changes: 1 } };
    }

    if (trimmed.startsWith("DELETE FROM sessions") && !trimmed.includes("WHERE")) {
      this.db.sessions.clear();
      return { success: true, meta: { changes: 1 } };
    }

    return { success: true, meta: { changes: 0 } };
  }
}

export async function runD1PersistenceTests(): Promise<{ passed: number; failed: number }> {
  console.log("==================================================");
  console.log("     RUNNING CLOUDFLARE D1 PERSISTENCE TESTS      ");
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
  // TEST 1: D1 Store Basic Operations & Schema Conformance
  // -------------------------------------------------------------
  console.log("\n[1/6] Testing CloudflareD1SessionStore creation & retrieval...");
  const mockDb = new MockD1Database();
  const d1Store = new CloudflareD1SessionStore(mockDb);
  const smD1 = new SessionManager({ store: d1Store });

  const session1 = await smD1.createSessionAsync("shopify", { customer: "Store Alpha" });
  assert(Boolean(session1.id), "D1 session created with unique ID");
  assert(Boolean(session1.authToken.startsWith("stok_")), "D1 session created with secure authToken");
  assert(session1.productId === "shopify", "D1 session bound to canonical product");

  const fetched = await smD1.getSessionAsync(session1.id);
  assert(Boolean(fetched), "D1 store retrieves persisted session");
  assert(fetched?.id === session1.id, "Fetched session ID matches");
  assert(fetched?.productId === "shopify", "Fetched session retains product binding");
  assert(fetched?.metadata?.customer === "Store Alpha", "Fetched session retains metadata JSON");

  // -------------------------------------------------------------
  // TEST 2: Durable Conversation History & Atomic Batching
  // -------------------------------------------------------------
  console.log("\n[2/6] Testing durable conversation turn updates via batching...");
  const turn1: ConversationTurn = { role: "user", text: "What is your pilot price?", timestamp: Date.now() };
  const turn2: ConversationTurn = {
    role: "model",
    text: "Our Shopify pilot is strictly $400.",
    toolCalls: [{ tool: "getOffer", result: { pilot_price: 400 } }],
    timestamp: Date.now() + 10
  };

  await smD1.addTurnAsync(session1.id, turn1, session1.authToken);
  await smD1.addTurnAsync(session1.id, turn2, session1.authToken);

  const withTurns = await smD1.getSessionAsync(session1.id);
  assert(withTurns?.conversationHistory.length === 2, "Conversation history contains 2 turns");
  assert(withTurns?.conversationHistory[0].text === "What is your pilot price?", "Turn 1 text matches");
  assert(withTurns?.conversationHistory[1].toolCalls?.[0]?.tool === "getOffer", "Turn 2 tool calls preserved");

  // -------------------------------------------------------------
  // TEST 3: Optimistic Concurrency Control (Lost Write Protection)
  // -------------------------------------------------------------
  console.log("\n[3/6] Testing optimistic concurrency control & versioning...");
  // Simulate concurrent update conflict by modifying version behind store's back
  const rawSession = mockDb.sessions.get(session1.id);
  assert(rawSession.version > 1, "Session version incremented on mutations");

  // Attempting concurrent set with stale version must detect conflict
  let concurrencyConflictCaught = false;
  try {
    const staleSession: SalesSession = { ...(fetched as any), lastActivityAt: Date.now() };
    rawSession.version = 999; // Corrupt version to simulate concurrent mutation
    await d1Store.set(session1.id, staleSession);
  } catch (err: any) {
    if (err.message.includes("Optimistic concurrency conflict")) {
      concurrencyConflictCaught = true;
    }
  }
  assert(concurrencyConflictCaught, "Optimistic concurrency conflict throws error on version mismatch");
  rawSession.version = 3; // Reset version

  // -------------------------------------------------------------
  // TEST 4: Mutation Authorization Token Enforcement
  // -------------------------------------------------------------
  console.log("\n[4/6] Testing authorization token enforcement on mutations...");
  let unauthorizedTurnRejected = false;
  try {
    const badTurn: ConversationTurn = { role: "user", text: "Hacked turn", timestamp: Date.now() };
    await smD1.addTurnAsync(session1.id, badTurn, "invalid_stok_token");
  } catch (err) {
    if (err instanceof UnauthorizedSessionAccessError) {
      unauthorizedTurnRejected = true;
    }
  }
  assert(unauthorizedTurnRejected, "addTurnAsync rejects invalid authorization token");

  let unauthorizedClearRejected = false;
  try {
    await smD1.clearSessionAsync(session1.id, "invalid_stok_token");
  } catch (err) {
    if (err instanceof UnauthorizedSessionAccessError) {
      unauthorizedClearRejected = true;
    }
  }
  assert(unauthorizedClearRejected, "clearSessionAsync rejects invalid authorization token");

  // Authorized clear succeeds
  await smD1.clearSessionAsync(session1.id, session1.authToken);
  const clearedSession = await smD1.getSessionAsync(session1.id);
  assert(clearedSession?.conversationHistory.length === 0, "Authorized clear empties conversation history");

  // -------------------------------------------------------------
  // TEST 5: Session Expiration & TTL Cleanup
  // -------------------------------------------------------------
  console.log("\n[5/6] Testing TTL expiration and SQL cleanup...");
  const shortSm = new SessionManager({ store: d1Store, ttlMs: 10 });
  const expiringSession = await shortSm.createSessionAsync("ghostwriter");

  // Wait 25ms to exceed TTL
  await new Promise(r => setTimeout(r, 25));

  const expiredCheck = await shortSm.getSessionAsync(expiringSession.id);
  assert(expiredCheck === undefined, "Expired session returns undefined on getSessionAsync");

  // Test SQL batch cleanup
  const cleanedCount = await d1Store.cleanupExpired(10);
  assert(cleanedCount >= 1, "cleanupExpired removes stale sessions via SQL query");

  // -------------------------------------------------------------
  // TEST 6: D1 Failure Propagation (No Silent Fallback)
  // -------------------------------------------------------------
  console.log("\n[6/8] Testing failure propagation on D1 errors...");
  mockDb.shouldFail = true;
  let failurePropagated = false;
  try {
    await smD1.getSessionAsync(session1.id);
  } catch (err: any) {
    failurePropagated = true;
  }
  assert(failurePropagated, "D1 query failure propagates error instead of silent memory fallback");
  mockDb.shouldFail = false;

  // -------------------------------------------------------------
  // TEST 7: Multi-Statement Concurrency Conflict (Zero Orphan Turns)
  // -------------------------------------------------------------
  console.log("\n[7/8] Testing multi-statement atomic conflict safety (no orphan turns)...");
  const turnCountBefore = mockDb.turns.length;
  const conflictSession = await smD1.createSessionAsync("shopify");
  // Set version to 999 to simulate conflict on update
  const rawConf = mockDb.sessions.get(conflictSession.id);
  rawConf.version = 999;

  let conflictTurnFailed = false;
  try {
    await smD1.addTurnAsync(
      conflictSession.id,
      { role: "user", text: "Orphan check turn", timestamp: Date.now() },
      conflictSession.authToken,
      (conflictSession as any).version
    );
  } catch (err: any) {
    if (err.message.includes("Optimistic concurrency conflict")) {
      conflictTurnFailed = true;
    }
  }
  assert(conflictTurnFailed, "Conflicted addTurnAsync throws optimistic concurrency error");
  const orphanTurns = mockDb.turns.filter(t => t.text === "Orphan check turn");
  assert(orphanTurns.length === 0, "No orphan turn written when version conflict occurs");

  // -------------------------------------------------------------
  // TEST 8: Atomic Batch Error Handling (Transaction Integrity)
  // -------------------------------------------------------------
  console.log("\n[8/8] Testing batch execution failure propagation...");
  mockDb.shouldFail = true;
  let batchErrorCaught = false;
  try {
    await smD1.addTurnAsync(conflictSession.id, { role: "user", text: "Batch fail turn", timestamp: Date.now() }, conflictSession.authToken);
  } catch (err: any) {
    batchErrorCaught = true;
  }
  assert(batchErrorCaught, "Batch execution failure throws error to caller");
  mockDb.shouldFail = false;

  console.log("\n--------------------------------------------------");
  console.log(`D1 Persistence Tests Summary: Passed: ${passed}, Failed: ${failed}`);
  console.log("==================================================");

  return { passed, failed };
}

if (process.argv[1] && process.argv[1].endsWith("d1-persistence-tests.ts")) {
  runD1PersistenceTests().then(summary => {
    process.exit(summary.failed === 0 ? 0 : 1);
  });
}
