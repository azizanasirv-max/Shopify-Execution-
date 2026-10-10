/**
 * Test Suite for Session Persistence, Durable Store, and Concurrency Guarantees
 *
 * Verifies:
 * 1. SessionStore interface conformance across InMemorySessionStore and FileSessionStore.
 * 2. Durable persistence and recovery across store restarts (FileSessionStore).
 * 3. Concurrent history updates safety via session-level mutex locking (`addTurnAsync`).
 * 4. Automatic TTL session expiration and cleanup.
 */

import {
  SessionManager,
  InMemorySessionStore,
  FileSessionStore,
  SessionNotFoundError
} from "../engine/session-manager.js";
import { ConversationTurn } from "../engine/types.js";
import fs from "fs";
import path from "path";

export async function runSessionPersistenceTests() {
  console.log("==================================================");
  console.log("   RUNNING SESSION PERSISTENCE & CONCURRENCY TESTS ");
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
  // TEST 1: InMemorySessionStore Operations
  // -------------------------------------------------------------
  console.log("\n[1/4] Testing InMemorySessionStore basic operations...");
  const memStore = new InMemorySessionStore();
  const smMem = new SessionManager({ store: memStore });
  const sess1 = smMem.createSession("shopify", { customer: "Acme Corp" });

  assert(memStore.size() === 1, "InMemorySessionStore records session count");
  assert(memStore.get(sess1.id)?.id === sess1.id, "InMemorySessionStore retrieves created session");
  assert(memStore.values().length === 1, "InMemorySessionStore enumerates values correctly");

  memStore.delete(sess1.id);
  assert(memStore.size() === 0, "InMemorySessionStore deletes session successfully");

  // -------------------------------------------------------------
  // TEST 2: Durable FileSessionStore Persistence & Recovery
  // -------------------------------------------------------------
  console.log("\n[2/4] Testing Durable FileSessionStore persistence and recovery...");
  const testFilePath = path.resolve("./data/test-sessions-persist.json");
  // Clean up any old test file
  if (fs.existsSync(testFilePath)) {
    fs.unlinkSync(testFilePath);
  }

  const fileStore1 = new FileSessionStore(testFilePath);
  const smFile1 = new SessionManager({ store: fileStore1 });
  const persistentSess = smFile1.createSession("ghostwriter", { project: "Book Beta" });
  smFile1.addTurn(persistentSess.id, { role: "user", text: "Hello ghostwriter", timestamp: Date.now() });

  // Create second FileSessionStore instance pointing to the same file (simulating server restart)
  const fileStore2 = new FileSessionStore(testFilePath);
  const smFile2 = new SessionManager({ store: fileStore2 });
  const recoveredSess = smFile2.getSession(persistentSess.id);

  assert(Boolean(recoveredSess), "FileSessionStore recovers session after restart");
  assert(recoveredSess?.productId === "ghostwriter", "Recovered session retains product binding");
  assert(recoveredSess?.conversationHistory.length === 1, "Recovered session preserves conversation history");
  assert(recoveredSess?.conversationHistory[0].text === "Hello ghostwriter", "Recovered session conversation text matches");

  // Cleanup test file
  if (fs.existsSync(testFilePath)) {
    fs.unlinkSync(testFilePath);
  }

  // -------------------------------------------------------------
  // TEST 3: Concurrent History Updates & Concurrency Guarantees
  // -------------------------------------------------------------
  console.log("\n[3/4] Testing concurrent history updates and mutex safety...");
  const smConc = new SessionManager();
  const concSess = smConc.createSession("shopify");

  const turn1: ConversationTurn = { role: "user", text: "Turn 1 concurrent", timestamp: Date.now() };
  const turn2: ConversationTurn = { role: "user", text: "Turn 2 concurrent", timestamp: Date.now() + 1 };
  const turn3: ConversationTurn = { role: "model", text: "Turn 3 model", timestamp: Date.now() + 2 };

  // Fire concurrent async updates using addTurnAsync
  await Promise.all([
    smConc.addTurnAsync(concSess.id, turn1),
    smConc.addTurnAsync(concSess.id, turn2),
    smConc.addTurnAsync(concSess.id, turn3)
  ]);

  const updatedSess = smConc.getSession(concSess.id);
  assert(updatedSess?.conversationHistory.length === 3, "Concurrent updates did not overwrite; all 3 turns preserved");
  assert(Boolean(updatedSess?.conversationHistory.some(t => t.text === "Turn 1 concurrent")), "Turn 1 present");
  assert(Boolean(updatedSess?.conversationHistory.some(t => t.text === "Turn 2 concurrent")), "Turn 2 present");
  assert(Boolean(updatedSess?.conversationHistory.some(t => t.text === "Turn 3 model")), "Turn 3 present");

  // -------------------------------------------------------------
  // TEST 4: Session TTL Expiration
  // -------------------------------------------------------------
  console.log("\n[4/4] Testing TTL session expiration...");
  const shortTtlSm = new SessionManager({ ttlMs: 5 }); // 5ms TTL
  const shortSess = shortTtlSm.createSession("shopify");

  assert(Boolean(shortTtlSm.getSession(shortSess.id)), "Session is active before TTL expires");

  // Wait 15ms
  await new Promise(r => setTimeout(r, 15));

  assert(shortTtlSm.getSession(shortSess.id) === undefined, "Session expires and returns undefined after TTL");

  console.log("\n--------------------------------------------------");
  console.log(`Session Persistence Test Summary: Passed: ${passed}, Failed: ${failed}`);
  console.log("==================================================");

  return { passed, failed };
}

// Allow direct execution if run via tsx
if (process.argv[1] && process.argv[1].endsWith("session-persistence-tests.ts")) {
  runSessionPersistenceTests().then(summary => {
    process.exit(summary.failed === 0 ? 0 : 1);
  });
}
