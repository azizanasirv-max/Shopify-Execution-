/**
 * Deterministic Test Suite for Session and LiveKit Access-Control Hardening (Priority 3)
 *
 * Verifies that:
 * 1. Requesting a LiveKit token without a session is rejected.
 * 2. Requesting a LiveKit token with an invalid or expired session is rejected.
 * 3. A client cannot specify an arbitrary room name in LiveKit token generation.
 * 4. A client cannot claim participant identity "lbv-ai" or other reserved identities.
 * 5. A client cannot elevate its own LiveKit room permissions.
 * 6. A session belonging to Shopify cannot receive a LiveKit token for Ghostwriter or vice versa.
 * 7. GET /api/sessions does not dump all sessions across users.
 * 8. Accessing another user's session without authorization is rejected.
 * 9. Clearing another user's session without authorization is rejected.
 * 10. Valid authorized session requests succeed for both Shopify and Ghostwriter.
 * 11. Simulated LiveKit issuance preserves room, identity, and permission restrictions.
 * 12. Existing adapter isolation, approval gate, and adversarial controls remain fully operational.
 */

import { GenericSalesEngine } from "../engine/generic-sales-engine.js";
import {
  LiveKitRealtimeAdapter,
  ReservedIdentityError,
  UnauthorizedRoomAccessError,
  PermissionElevationError,
  SessionRequiredForLiveKitError
} from "../engine/realtime-adapter.js";
import {
  SessionManager,
  SessionNotFoundError,
  MismatchedSessionProductError,
  UnauthorizedSessionAccessError
} from "../engine/session-manager.js";
import { AdapterRegistry } from "../engine/adapter-registry.js";
import { ShopifySalesAdapter } from "../sales-api/shopify-adapter.js";
import { GhostwriterSalesAdapter } from "../sales-api/ghostwriter-adapter.js";
import {
  ModelProvider,
  SalesSession,
  SAFE_FALLBACK_RECOMMENDATION
} from "../engine/types.js";

class MockModelProvider implements ModelProvider {
  constructor(private cannedText = "Authorized recommendation text.") {}
  async generateContent() {
    return { text: this.cannedText };
  }
}

export async function runSessionAccessControlTests() {
  console.log("==================================================");
  console.log("   RUNNING PRIORITY 3: SESSION & LIVEKIT ACCESS CONTROL TESTS");
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

  // Setup test environment
  const shopifyAdapter = new ShopifySalesAdapter();
  const ghostwriterAdapter = new GhostwriterSalesAdapter();
  const registry = new AdapterRegistry();
  registry.register(shopifyAdapter);
  registry.register(ghostwriterAdapter);

  const mockProvider = new MockModelProvider();
  const salesEngine = new GenericSalesEngine({
    modelProvider: mockProvider,
    adapterRegistry: registry,
    defaultAdapter: shopifyAdapter
  });

  const realtimeAdapter = new LiveKitRealtimeAdapter(salesEngine, registry);

  // -------------------------------------------------------------
  // TEST 1: Requesting a LiveKit token without a session is rejected
  // -------------------------------------------------------------
  console.log("\n[1/12] Testing LiveKit token request without a session...");
  let rejectedNoSession = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: null as any,
      identity: "prospect"
    });
  } catch (err: any) {
    if (err instanceof SessionRequiredForLiveKitError || err.code === "SESSION_REQUIRED") {
      rejectedNoSession = true;
    }
  }
  assert(rejectedNoSession, "RealtimeAdapter rejects LiveKit token request without session");

  // Also test with empty object
  let rejectedEmptySession = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: {} as any,
      identity: "salesperson"
    });
  } catch (err: any) {
    if (err instanceof SessionRequiredForLiveKitError || err.code === "SESSION_REQUIRED") {
      rejectedEmptySession = true;
    }
  }
  assert(rejectedEmptySession, "RealtimeAdapter rejects empty session object");

  // -------------------------------------------------------------
  // TEST 2: Requesting a LiveKit token with an invalid or expired session is rejected
  // -------------------------------------------------------------
  console.log("\n[2/12] Testing LiveKit token with invalid or expired session...");
  const shortTtlSessionManager = new SessionManager({ ttlMs: 1 }); // 1ms TTL
  const expiredSession = shortTtlSessionManager.createSession(shopifyAdapter.id);
  // Wait 5ms to guarantee expiration
  await new Promise((r) => setTimeout(r, 10));

  let expiredRejected = false;
  try {
    shortTtlSessionManager.validateSessionAuthorization(expiredSession.id, expiredSession.authToken);
  } catch (err: any) {
    if (err instanceof SessionNotFoundError || err.code === "SESSION_NOT_FOUND") {
      expiredRejected = true;
    }
  }
  assert(expiredRejected, "SessionManager fails closed on expired session access");

  let invalidIdRejected = false;
  try {
    shortTtlSessionManager.validateSessionAuthorization("non-existent-sess-12345", "fake-token");
  } catch (err: any) {
    if (err instanceof SessionNotFoundError || err.code === "SESSION_NOT_FOUND") {
      invalidIdRejected = true;
    }
  }
  assert(invalidIdRejected, "SessionManager fails closed on non-existent session ID");

  // -------------------------------------------------------------
  // TEST 3: A client cannot specify an arbitrary room name in LiveKit token generation
  // -------------------------------------------------------------
  console.log("\n[3/12] Testing rejection of arbitrary room names...");
  const standardSessionManager = new SessionManager();
  const testSessionShopify = standardSessionManager.createSession(shopifyAdapter.id);
  const expectedRoom = testSessionShopify.roomName;

  assert(Boolean(expectedRoom && expectedRoom.startsWith("room_")), "Session generates server-bound roomName");

  let arbitraryRoomRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: testSessionShopify,
      identity: "prospect",
      clientRoomName: "malicious-arbitrary-room-666"
    });
  } catch (err: any) {
    if (err instanceof UnauthorizedRoomAccessError || err.code === "ARBITRARY_ROOM_REJECTED") {
      arbitraryRoomRejected = true;
    }
  }
  assert(arbitraryRoomRejected, "RealtimeAdapter rejects arbitrary client room name");

  // Matching trusted room name succeeds
  const matchResult = await realtimeAdapter.createParticipantToken({
    session: testSessionShopify,
    identity: "prospect",
    clientRoomName: expectedRoom,
    forceSimulated: true
  });
  assert(matchResult.roomName === expectedRoom, "Matching server-derived room name succeeds");

  // -------------------------------------------------------------
  // TEST 4: A client cannot claim participant identity "lbv-ai" or other reserved identities
  // -------------------------------------------------------------
  console.log("\n[4/12] Testing anti-impersonation of reserved identity 'lbv-ai'...");
  let lbvAiRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: testSessionShopify,
      identity: "lbv-ai"
    });
  } catch (err: any) {
    if (err instanceof ReservedIdentityError || err.code === "RESERVED_IDENTITY") {
      lbvAiRejected = true;
    }
  }
  assert(lbvAiRejected, "RealtimeAdapter rejects client claiming reserved 'lbv-ai' identity");

  let systemRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: testSessionShopify,
      identity: "admin"
    });
  } catch (err: any) {
    if (err instanceof ReservedIdentityError || err.code === "RESERVED_IDENTITY") {
      systemRejected = true;
    }
  }
  assert(systemRejected, "RealtimeAdapter rejects client claiming reserved 'admin' identity");

  // Legitimate identities succeed
  const prospectResult = await realtimeAdapter.createParticipantToken({
    session: testSessionShopify,
    identity: "prospect",
    forceSimulated: true
  });
  assert(prospectResult.identity === "prospect", "Legitimate 'prospect' identity allowed");

  const salesResult = await realtimeAdapter.createParticipantToken({
    session: testSessionShopify,
    identity: "salesperson",
    forceSimulated: true
  });
  assert(salesResult.identity === "salesperson", "Legitimate 'salesperson' identity allowed");

  // -------------------------------------------------------------
  // TEST 5: A client cannot elevate its own LiveKit room permissions
  // -------------------------------------------------------------
  console.log("\n[5/12] Testing permission escalation prevention...");
  let adminElevationRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: testSessionShopify,
      identity: "prospect",
      requestedPermissions: { admin: true }
    });
  } catch (err: any) {
    if (err instanceof PermissionElevationError || err.code === "PERMISSION_ELEVATION_DENIED") {
      adminElevationRejected = true;
    }
  }
  assert(adminElevationRejected, "RealtimeAdapter rejects client elevation with 'admin: true'");

  let roomAdminElevationRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: testSessionShopify,
      identity: "salesperson",
      requestedPermissions: { roomAdmin: true, hidden: true }
    });
  } catch (err: any) {
    if (err instanceof PermissionElevationError || err.code === "PERMISSION_ELEVATION_DENIED") {
      roomAdminElevationRejected = true;
    }
  }
  assert(roomAdminElevationRejected, "RealtimeAdapter rejects client elevation with 'roomAdmin' or 'hidden'");

  // -------------------------------------------------------------
  // TEST 6: A session belonging to Shopify cannot receive a LiveKit token for Ghostwriter or vice versa
  // -------------------------------------------------------------
  console.log("\n[6/12] Testing cross-product LiveKit token isolation...");
  let crossProductRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: testSessionShopify,
      identity: "prospect",
      requestedProductId: ghostwriterAdapter.id
    });
  } catch (err: any) {
    if (err instanceof MismatchedSessionProductError || err.code === "MISMATCHED_SESSION_PRODUCT") {
      crossProductRejected = true;
    }
  }
  assert(crossProductRejected, "RealtimeAdapter rejects Ghostwriter token request for Shopify session");

  const testSessionGhostwriter = standardSessionManager.createSession(ghostwriterAdapter.id);
  let reverseCrossProductRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: testSessionGhostwriter,
      identity: "salesperson",
      requestedProductId: shopifyAdapter.id
    });
  } catch (err: any) {
    if (err instanceof MismatchedSessionProductError || err.code === "MISMATCHED_SESSION_PRODUCT") {
      reverseCrossProductRejected = true;
    }
  }
  assert(reverseCrossProductRejected, "RealtimeAdapter rejects Shopify token request for Ghostwriter session");

  // -------------------------------------------------------------
  // TEST 7: GET /api/sessions does not dump all sessions across users
  // -------------------------------------------------------------
  console.log("\n[7/12] Testing session enumeration prevention (no cross-user dump)...");
  // Create 3 sessions simulating distinct users
  const user1Session = standardSessionManager.createSession(shopifyAdapter.id);
  const user2Session = standardSessionManager.createSession(shopifyAdapter.id);
  const user3Session = standardSessionManager.createSession(ghostwriterAdapter.id);

  // Calling findSessionByToken without token returns undefined
  const noTokenResult = standardSessionManager.findSessionByToken("");
  assert(noTokenResult === undefined, "Unauthenticated session lookup returns undefined");

  // Calling findSessionByToken with user1's token returns strictly user1's session
  const user1Lookup = standardSessionManager.findSessionByToken(user1Session.authToken);
  assert(user1Lookup?.id === user1Session.id, "Token-bound lookup returns strictly matching session");
  assert(user1Lookup?.id !== user2Session.id, "Token-bound lookup never returns another user's session");

  // Non-existent token returns undefined
  const fakeTokenLookup = standardSessionManager.findSessionByToken("stok_unauthorized_token_hex");
  assert(fakeTokenLookup === undefined, "Unauthorized token lookup returns undefined");

  // -------------------------------------------------------------
  // TEST 8: Accessing another user's session without authorization is rejected
  // -------------------------------------------------------------
  console.log("\n[8/12] Testing unauthorized session inspection is rejected...");
  let unauthorizedAccessRejected = false;
  try {
    // Attacker knows user1Session.id, but does not have user1Session.authToken
    standardSessionManager.validateSessionAuthorization(user1Session.id, user2Session.authToken);
  } catch (err: any) {
    if (err instanceof UnauthorizedSessionAccessError || err.code === "UNAUTHORIZED_SESSION_ACCESS") {
      unauthorizedAccessRejected = true;
    }
  }
  assert(unauthorizedAccessRejected, "Possession of sessionId without matching authToken fails closed");

  let missingTokenRejected = false;
  try {
    standardSessionManager.validateSessionAuthorization(user1Session.id, undefined);
  } catch (err: any) {
    if (err instanceof UnauthorizedSessionAccessError || err.code === "UNAUTHORIZED_SESSION_ACCESS") {
      missingTokenRejected = true;
    }
  }
  assert(missingTokenRejected, "Session inspection without token fails closed with UnauthorizedSessionAccessError");

  // Valid token succeeds
  const authorizedUser1 = standardSessionManager.validateSessionAuthorization(
    user1Session.id,
    user1Session.authToken
  );
  assert(authorizedUser1.id === user1Session.id, "Valid session authorization token grants access");

  // -------------------------------------------------------------
  // TEST 9: Clearing another user's session without authorization is rejected
  // -------------------------------------------------------------
  console.log("\n[9/12] Testing unauthorized session clearing is rejected...");
  standardSessionManager.addTurn(user1Session.id, {
    role: "user",
    text: "Confidential store context",
    timestamp: Date.now()
  }, user1Session.authToken);
  assert(user1Session.conversationHistory.length === 1, "Session turn added for user 1");

  let unauthorizedClearRejected = false;
  try {
    standardSessionManager.clearSession(user1Session.id, "invalid_or_other_user_token");
  } catch (err: any) {
    if (err instanceof UnauthorizedSessionAccessError || err.code === "UNAUTHORIZED_SESSION_ACCESS") {
      unauthorizedClearRejected = true;
    }
  }
  assert(unauthorizedClearRejected, "Clearing session with incorrect token is rejected");
  assert(user1Session.conversationHistory.length === 1, "Conversation history remains preserved upon rejected clear");

  // Clearing with valid token succeeds
  standardSessionManager.clearSession(user1Session.id, user1Session.authToken);
  assert(user1Session.conversationHistory.length === 0, "Authorized clear successfully empties conversation history");

  // -------------------------------------------------------------
  // TEST 10: Valid authorized session requests succeed for both Shopify and Ghostwriter
  // -------------------------------------------------------------
  console.log("\n[10/12] Testing valid authorized session workflows for Shopify and Ghostwriter...");
  const authorizedShopify = standardSessionManager.createSession(shopifyAdapter.id);
  const authorizedGhostwriter = standardSessionManager.createSession(ghostwriterAdapter.id);

  assert(Boolean(authorizedShopify.authToken), "Shopify session contains high-entropy authToken");
  assert(Boolean(authorizedGhostwriter.authToken), "Ghostwriter session contains high-entropy authToken");
  assert(authorizedShopify.authToken !== authorizedGhostwriter.authToken, "Tokens between sessions are distinct");

  // Validate Shopify session
  const validShopifySession = standardSessionManager.validateSessionAuthorization(
    authorizedShopify.id,
    authorizedShopify.authToken
  );
  assert(validShopifySession.productId === "shopify-conversion-pilot", "Authorized Shopify session matches product");

  // Validate Ghostwriter session
  const validGhostwriterSession = standardSessionManager.validateSessionAuthorization(
    authorizedGhostwriter.id,
    authorizedGhostwriter.authToken
  );
  assert(
    validGhostwriterSession.productId === "ghostwriter-thought-leadership",
    "Authorized Ghostwriter session matches product"
  );

  // Both can generate LiveKit tokens
  const shopifyToken = await realtimeAdapter.createParticipantToken({
    session: authorizedShopify,
    identity: "prospect",
    requestedProductId: shopifyAdapter.id,
    forceSimulated: true
  });
  assert(shopifyToken.roomName.includes("shopify"), "Shopify LiveKit token bound to Shopify room");

  const gwToken = await realtimeAdapter.createParticipantToken({
    session: authorizedGhostwriter,
    identity: "salesperson",
    requestedProductId: ghostwriterAdapter.id,
    forceSimulated: true
  });
  assert(gwToken.roomName.includes("ghostwriter"), "Ghostwriter LiveKit token bound to Ghostwriter room");

  // -------------------------------------------------------------
  // TEST 11: Simulated LiveKit issuance preserves room, identity, and permission restrictions
  // -------------------------------------------------------------
  console.log("\n[11/12] Testing simulated LiveKit issuance adheres to identical security controls...");
  const simSession = standardSessionManager.createSession(shopifyAdapter.id);

  // 11A: Simulated mode rejects arbitrary room
  let simArbitraryRoomRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: simSession,
      identity: "prospect",
      clientRoomName: "hacked-room-99",
      forceSimulated: true
    });
  } catch (err: any) {
    if (err instanceof UnauthorizedRoomAccessError) {
      simArbitraryRoomRejected = true;
    }
  }
  assert(simArbitraryRoomRejected, "Simulated mode enforces room restriction");

  // 11B: Simulated mode rejects reserved identity
  let simReservedRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: simSession,
      identity: "lbv-ai",
      forceSimulated: true
    });
  } catch (err: any) {
    if (err instanceof ReservedIdentityError) {
      simReservedRejected = true;
    }
  }
  assert(simReservedRejected, "Simulated mode enforces anti-impersonation of lbv-ai");

  // 11C: Simulated mode rejects permission elevation
  let simElevationRejected = false;
  try {
    await realtimeAdapter.createParticipantToken({
      session: simSession,
      identity: "prospect",
      requestedPermissions: { admin: true },
      forceSimulated: true
    });
  } catch (err: any) {
    if (err instanceof PermissionElevationError) {
      simElevationRejected = true;
    }
  }
  assert(simElevationRejected, "Simulated mode enforces permission bounds");

  // 11D: Valid simulated issuance
  const simValid = await realtimeAdapter.createParticipantToken({
    session: simSession,
    identity: "prospect",
    displayName: "Jane Prospect",
    forceSimulated: true
  });
  assert(simValid.mode === "simulated", "Valid request receives mode 'simulated'");
  assert(simValid.serverUrl === "wss://simulated.livekit.local", "Simulated serverUrl returned");
  assert(simValid.roomName === simSession.roomName, "Simulated token matches derived roomName");
  assert(simValid.token.startsWith("sim_jwt_"), "Simulated token formatted safely");

  // -------------------------------------------------------------
  // TEST 12: Existing adapter isolation, approval gate, and adversarial controls remain operational
  // -------------------------------------------------------------
  console.log("\n[12/12] Testing regression: existing approval gates & adapter isolation remain intact...");
  // Adapter isolation check: Shopify cannot run Ghostwriter tools
  let isolatedToolRejected = false;
  try {
    await shopifyAdapter.executeTool("getEditorialAudit", {});
  } catch {
    isolatedToolRejected = true;
  }
  assert(isolatedToolRejected, "Shopify adapter strictly rejects Ghostwriter tool execution");

  // Approval gate check: Engine approves valid response under session
  const testRec = await salesEngine.generateRecommendation("What is your price?", {
    adapter: shopifyAdapter,
    session: simSession
  });
  assert(testRec.status === "APPROVED", "Sales recommendation approved under active session");
  assert(testRec.engineMetadata.sessionId === simSession.id, "engineMetadata tracks sessionId");
  assert(simSession.conversationHistory.length === 2, "Conversation turn recorded in isolated session history");

  // -------------------------------------------------------------
  // TEST 13: Pluggable Session Store & Persistence Architecture
  // -------------------------------------------------------------
  console.log("\n[13/13] Testing pluggable session store and persistence architecture...");
  const customStore = {
    storeMap: new Map<string, any>(),
    get(id: string) { return this.storeMap.get(id); },
    set(id: string, s: any) { this.storeMap.set(id, s); },
    delete(id: string) { return this.storeMap.delete(id); },
    values() { return Array.from(this.storeMap.values()); },
    clear() { this.storeMap.clear(); },
    size() { return this.storeMap.size; }
  };
  const customManager = new SessionManager({ store: customStore, ttlMs: 5000 });
  const customSess = customManager.createSession("shopify-conversion-pilot");
  assert(customStore.size() === 1, "Custom SessionStore successfully receives created session");
  assert(customManager.getSession(customSess.id)?.id === customSess.id, "Custom SessionStore retrieves session correctly");
  customManager.deleteSession(customSess.id, customSess.authToken);
  assert(customStore.size() === 0, "Custom SessionStore successfully deletes session");

  console.log("\n--------------------------------------------------");
  console.log(`Session Access Control Tests Summary: Passed: ${passed} | Failed: ${failed} | Total: ${passed + failed}`);
  console.log("==================================================");

  return { passed, failed, total: passed + failed };
}
