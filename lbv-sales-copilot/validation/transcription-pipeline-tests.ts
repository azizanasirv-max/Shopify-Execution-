/**
 * Transcription Pipeline Tests
 *
 * Deterministic, offline regression tests for the prospect live-transcription
 * pipeline:
 *
 *  1. Prospect identity contract - the agent's pinned `PROSPECT_IDENTITY` must
 *     equal the identity the Worker issues to the prospect.
 *  2. Participant linking - the agent must pin the LiveKit Agents session to the
 *     prospect. Without `inputOptions.participantIdentity` the SDK links to the
 *     FIRST participant (normally the salesperson), so prospect audio never
 *     reaches AssemblyAI and the published transcript carries the wrong identity.
 *  3. Dispatch safety - the Worker never dispatches agents, so the agent must
 *     remain on automatic dispatch (no non-empty agent name configured).
 *  4. Transcription filtering - only FINAL, non-empty PROSPECT segments may be
 *     forwarded to the approval gate (real behaviour of src/sales/transcriptFilter).
 *
 * No network access, no credentials, and no LiveKit connection are required.
 * These tests assert configuration/contracts and pure filtering logic only; they
 * cannot prove that real speech is transcribed (that requires a deployed agent).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  PROSPECT_IDENTITY,
  isProspectIdentity,
  segmentText,
  isFinalSegment,
  shouldForwardProspectSegment,
} from "../../src/sales/transcriptFilter.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

export async function runTranscriptionPipelineTests(): Promise<{ passed: number; failed: number }> {
  console.log("==================================================");
  console.log("       RUNNING TRANSCRIPTION PIPELINE TESTS       ");
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

  const agentSource = readSource("agent/agent.ts");
  const workerSource = readSource("worker.ts");
  const serverSource = readSource("server.ts");
  const realtimeAdapterSource = readSource("lbv-sales-copilot/engine/realtime-adapter.ts");
  const roomComponentSource = readSource("lbv-sales-copilot/app/LiveKitSalesRoom.tsx");

  // -------------------------------------------------------------
  // 1. Prospect identity contract (agent <-> Worker)
  // -------------------------------------------------------------
  console.log("\n[1/4] Prospect identity contract...");

  const agentIdentity = /const PROSPECT_IDENTITY = "([^"]+)"/.exec(agentSource)?.[1];
  assert(
    agentIdentity === "prospect",
    "agent pins PROSPECT_IDENTITY to 'prospect'",
    `found: ${agentIdentity}`
  );

  assert(
    /identity:\s*"prospect"/.test(workerSource),
    "Worker invite-token route issues identity 'prospect'"
  );

  assert(
    agentIdentity === PROSPECT_IDENTITY && PROSPECT_IDENTITY === "prospect",
    "agent identity constant matches the shared transcriptFilter identity"
  );

  assert(
    realtimeAdapterSource.includes('identity.startsWith("prospect")'),
    "realtime adapter treats 'prospect*' identities as the prospect role"
  );

  // -------------------------------------------------------------
  // 2. Participant linking (the regression this change fixes)
  // -------------------------------------------------------------
  console.log("\n[2/4] Agent participant linking...");

  const startCallMatch = /session\.start\(\{([\s\S]*?)\n\s*\}\);/.exec(agentSource);
  const startCallBody = startCallMatch?.[1] ?? "";

  assert(startCallMatch !== null, "agent calls session.start({...})");
  assert(
    /inputOptions:\s*\{[^}]*participantIdentity:\s*PROSPECT_IDENTITY/.test(startCallBody),
    "session.start() pins inputOptions.participantIdentity to PROSPECT_IDENTITY",
    "without this the SDK links the session to the FIRST participant (the salesperson)"
  );
  assert(
    !/participantIdentity:\s*["']salesperson["']/.test(agentSource),
    "agent never links the session to the salesperson"
  );
  assert(
    /_roomIO\?\.linkedParticipant/.test(agentSource) &&
      /linked participant \(/.test(agentSource),
    "agent logs the participant it actually linked to (credential-free diagnostic)"
  );

  // -------------------------------------------------------------
  // 3. Dispatch safety
  // -------------------------------------------------------------
  console.log("\n[3/4] Dispatch configuration...");

  const dispatchConfigSources: Array<[string, string]> = [
    ["worker.ts", workerSource],
    ["server.ts", serverSource],
    ["realtime-adapter.ts", realtimeAdapterSource],
  ];

  for (const [name, source] of dispatchConfigSources) {
    assert(
      !/RoomConfiguration|RoomAgentDispatch|AgentDispatchClient|roomAgents/.test(source),
      `${name} contains no explicit agent-dispatch configuration`
    );
  }

  assert(
    /resolveAgentName/.test(agentSource) &&
      /LIVEKIT_AGENT_NAME_OVERRIDE/.test(agentSource) &&
      /LIVEKIT_AGENT_ROOM/.test(agentSource) &&
      /LIVEKIT_AGENT_NAME\b/.test(agentSource),
    "agent resolves the dispatch agent name from env exactly as the SDK does"
  );
  assert(
    /dispatch=AUTOMATIC/.test(agentSource),
    "agent logs an explicit AUTOMATIC-dispatch diagnostic when no agent name is set"
  );
  assert(
    /dispatch=EXPLICIT/.test(agentSource),
    "agent warns when explicit dispatch is enabled (it would never be auto-dispatched)"
  );
  assert(
    /ctx\.job\?\.agentName/.test(agentSource),
    "agent logs the server-provided job agent name (authoritative dispatch evidence)"
  );

  // -------------------------------------------------------------
  // 4. Transcription filtering (real module behaviour)
  // -------------------------------------------------------------
  console.log("\n[4/4] Prospect transcription filtering...");

  assert(isProspectIdentity("prospect") === true, "identity 'prospect' is the prospect");
  assert(isProspectIdentity("PROSPECT") === true, "prospect identity is case-insensitive");
  assert(isProspectIdentity("prospect_abc123") === true, "scoped 'prospect_*' identity is the prospect");
  assert(isProspectIdentity("salesperson") === false, "identity 'salesperson' is not the prospect");
  assert(isProspectIdentity("salesperson_1") === false, "scoped salesperson identity is not the prospect");
  assert(isProspectIdentity(undefined) === false, "missing identity is not the prospect");
  assert(isProspectIdentity(null) === false, "null identity is not the prospect");
  assert(isProspectIdentity(42) === false, "non-string identity is not the prospect");

  assert(
    shouldForwardProspectSegment({ text: "hello", final: true }, "prospect") === true,
    "FINAL prospect segment (legacy 'final' flag) is forwarded"
  );
  assert(
    shouldForwardProspectSegment({ text: "hello", isFinal: true }, "prospect") === true,
    "FINAL prospect segment ('isFinal' flag) is forwarded"
  );
  assert(
    shouldForwardProspectSegment({ transcript: "hello", final: true }, "prospect") === true,
    "legacy 'transcript' field is accepted"
  );
  assert(
    shouldForwardProspectSegment({ text: "hello", final: true }, "salesperson") === false,
    "salesperson segment is never forwarded"
  );
  assert(
    shouldForwardProspectSegment({ text: "hello", final: false }, "prospect") === false,
    "interim prospect segment is not forwarded"
  );
  assert(
    shouldForwardProspectSegment({ text: "   ", final: true }, "prospect") === false,
    "empty prospect segment is not forwarded"
  );
  assert(
    shouldForwardProspectSegment({ final: true }, "prospect") === false,
    "segment without text is not forwarded"
  );
  assert(
    shouldForwardProspectSegment({ text: "hi", final: true }, "prospect_zz") === true,
    "scoped prospect identity segment is forwarded"
  );
  assert(
    shouldForwardProspectSegment({ text: "hi", final: true }, undefined) === false,
    "segment without any identity is not forwarded"
  );
  assert(
    shouldForwardProspectSegment({ text: "hi", final: true, participantIdentity: "prospect" }, undefined) ===
      true,
    "falls back to the segment's own participantIdentity"
  );
  assert(
    shouldForwardProspectSegment(
      { text: "hi", final: true, participantIdentity: "prospect" },
      "salesperson"
    ) === false,
    "participant argument takes precedence over the segment identity"
  );

  assert(segmentText({ text: "a", transcript: "b" }) === "a", "segmentText prefers 'text'");
  assert(segmentText({ transcript: "b" }) === "b", "segmentText falls back to 'transcript'");
  assert(segmentText({ text: 5 as unknown as string }) === "", "segmentText ignores non-string text");
  assert(segmentText(null) === "", "segmentText tolerates null segments");
  assert(isFinalSegment({ final: true }) === true, "isFinalSegment accepts 'final'");
  assert(isFinalSegment({ isFinal: true }) === true, "isFinalSegment accepts 'isFinal'");
  assert(isFinalSegment({}) === false, "isFinalSegment rejects unflagged segments");

  // The UI must use the shared, tested filter rather than re-implementing it.
  assert(
    roomComponentSource.includes("shouldForwardProspectSegment") &&
      roomComponentSource.includes("src/sales/transcriptFilter"),
    "LiveKitSalesRoom uses the shared transcript filter"
  );
  assert(
    !/lower === "prospect" \|\| lower\.startsWith\("prospect_"\)/.test(roomComponentSource),
    "LiveKitSalesRoom no longer re-implements the prospect identity check inline"
  );

  // Privacy guard: no diagnostic may interpolate transcript text into a log.
  const logLines = agentSource.split("\n").filter((line) => line.includes("log()"));
  const leaking = logLines.filter((line) => /\$\{[^}]*\btranscript\b/.test(line));
  assert(
    leaking.length === 0,
    "agent diagnostics never interpolate transcript text",
    leaking.join(" | ")
  );
  assert(
    agentSource.includes("chars=") && !/speaker=\$\{/.test(agentSource),
    "agent logs transcript length only (no content, no misleading speakerId)"
  );

  console.log(`\nTranscription Pipeline Test Summary: Passed: ${passed}, Failed: ${failed}`);
  return { passed, failed };
}
