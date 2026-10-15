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
  shouldForwardTranscriptionStream,
  transcriptionStreamSegmentId,
  transcriptionHealth,
  TRANSCRIPTION_STREAM_TOPIC,
  TRANSCRIPTION_ATTR_FINAL,
  TRANSCRIPTION_ATTR_SEGMENT_ID,
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
  // 3b. STT model pinning + subscription diagnostics
  // -------------------------------------------------------------
  console.log("\n[3b/4] STT model + subscription diagnostics...");

  const pinnedModel = /const DEFAULT_ASSEMBLYAI_SPEECH_MODEL = "([^"]+)"/.exec(agentSource)?.[1];
  assert(
    Boolean(pinnedModel),
    "agent pins an explicit AssemblyAI speech model instead of inheriting the plugin default",
    "the installed plugin defaults to 'universal-3-5-pro', which this repo never documented"
  );
  assert(
    !/speechModel:\s*process\.env\.ASSEMBLYAI_SPEECH_MODEL as any/.test(agentSource),
    "agent no longer passes the plugin default through when the env override is unset"
  );
  assert(
    /speechModel: speechModel as any/.test(agentSource) && /resolveSpeechModel\(\)/.test(agentSource),
    "agent uses the resolved (pinned or overridden) speech model"
  );
  assert(
    /stt=assemblyai model=/.test(agentSource),
    "agent logs the effective STT model (no secrets) so a rejected model is diagnosable"
  );
  assert(
    /trackSubscribed/.test(agentSource) && /no prospect microphone track was subscribed/.test(agentSource),
    "agent reports whether prospect audio actually reached its subscription"
  );
  assert(
    /no final transcript was produced/.test(agentSource),
    "agent distinguishes 'no prospect audio' from 'STT produced nothing'"
  );
  assert(
    /outputOptions:\s*\{\s*audioEnabled:\s*false\s*\}/.test(startCallBody),
    "agent disables its own audio output (it never speaks; a silent mic track is pure call overhead)",
    "transcription output is a separate option and must stay enabled"
  );
  assert(
    !/outputOptions:\s*\{[^}]*transcriptionEnabled:\s*false/.test(agentSource),
    "agent never disables the transcription output"
  );

  // The client must consume BOTH transcription delivery mechanisms the Agents SDK
  // publishes (legacy signal + `lk.transcription` text stream). Consuming only one
  // silently empties the transcript panel when the SDK/client protocol shifts.
  assert(
    /registerTextStreamHandler\(/.test(roomComponentSource) &&
      /TRANSCRIPTION_STREAM_TOPIC/.test(roomComponentSource),
    "salesperson client registers a handler for the lk.transcription text stream"
  );
  assert(
    /shouldForwardTranscriptionStream/.test(roomComponentSource),
    "the text-stream path uses the same tested fail-closed filter"
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

  // -------------------------------------------------------------
  // 5. Transcription text streams (`lk.transcription`) - real behaviour
  // -------------------------------------------------------------
  console.log("\n[5/5] Transcription text-stream filtering...");

  const finalProspectStream = {
    topic: TRANSCRIPTION_STREAM_TOPIC,
    senderIdentity: "prospect",
    attributes: { [TRANSCRIPTION_ATTR_FINAL]: "true", [TRANSCRIPTION_ATTR_SEGMENT_ID]: "SG_1" },
  };

  assert(
    TRANSCRIPTION_STREAM_TOPIC === "lk.transcription",
    "the transcription stream topic matches the Agents SDK constant"
  );
  assert(
    TRANSCRIPTION_ATTR_FINAL === "lk.transcription_final" &&
      TRANSCRIPTION_ATTR_SEGMENT_ID === "lk.transcription_segment_id",
    "the transcription stream attribute names match the Agents SDK constants"
  );
  assert(
    shouldForwardTranscriptionStream(finalProspectStream) === true,
    "a FINAL prospect transcription stream is forwarded"
  );
  assert(
    shouldForwardTranscriptionStream({ ...finalProspectStream, senderIdentity: "salesperson" }) === false,
    "a salesperson transcription stream is never forwarded"
  );
  assert(
    shouldForwardTranscriptionStream({ ...finalProspectStream, senderIdentity: "lbv-agent" }) === false,
    "the agent's own transcription stream is never forwarded"
  );
  assert(
    shouldForwardTranscriptionStream({ ...finalProspectStream, senderIdentity: undefined }) === false,
    "a transcription stream without a sender identity is never forwarded"
  );
  assert(
    shouldForwardTranscriptionStream({ ...finalProspectStream, senderIdentity: "prospect_zz" }) === true,
    "a scoped prospect transcription stream is forwarded"
  );
  assert(
    shouldForwardTranscriptionStream({ ...finalProspectStream, attributes: {} }) === false,
    "a transcription stream without the FINAL marker is not forwarded"
  );
  assert(
    shouldForwardTranscriptionStream({
      ...finalProspectStream,
      attributes: { [TRANSCRIPTION_ATTR_FINAL]: "false" },
    }) === false,
    "an INTERIM transcription stream is not forwarded"
  );
  assert(
    shouldForwardTranscriptionStream({ ...finalProspectStream, topic: "lk.chat" }) === false,
    "a non-transcription stream is not forwarded"
  );
  assert(shouldForwardTranscriptionStream(undefined) === false, "a missing stream is not forwarded");
  assert(
    transcriptionStreamSegmentId(finalProspectStream) === "SG_1",
    "the stream segment id is read from the lk.transcription_segment_id attribute"
  );
  assert(
    transcriptionStreamSegmentId({ ...finalProspectStream, attributes: {} }) === undefined,
    "a stream without a segment id yields undefined"
  );

  // -------------------------------------------------------------
  // 6. Transcription health (so an empty panel is never ambiguous)
  // -------------------------------------------------------------
  console.log("\n[6/6] Transcription health states...");

  const health = (over: Partial<Parameters<typeof transcriptionHealth>[0]>) =>
    transcriptionHealth({
      connected: true,
      prospectPresent: true,
      segmentCount: 0,
      sinceProspectMs: 0,
      hasError: false,
      ...over,
    });

  assert(health({}) === "waiting", "connected + silent prospect starts as 'waiting'");
  assert(health({ segmentCount: 1 }) === "receiving", "'receiving' once a final segment arrives");
  assert(health({ sinceProspectMs: 15000 }) === "stalled", "a 15s silent prospect is 'stalled'");
  assert(health({ connected: false }) === "idle", "not connected is 'idle'");
  assert(health({ prospectPresent: false }) === "idle", "no prospect in the room is 'idle'");
  assert(health({ hasError: true }) === "error", "a transcription failure is 'error'");
  assert(
    health({ segmentCount: 3, sinceProspectMs: 60000 }) === "receiving",
    "'receiving' wins over elapsed silence once segments exist"
  );

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
