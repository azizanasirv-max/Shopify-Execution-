# LBV Sales Copilot — Production Diagnosis (no code changes)

Investigation only. No application code, configuration, credentials, or
architecture was modified. Findings below are labelled by evidence class:

- **CONFIRMED** — proven by code plus a source-level or executed test.
- **FAILED** — proven broken by code plus a source-level test.
- **RUNTIME-UNVERIFIED** — cannot be decided from the repository; requires
  LiveKit Cloud / agent / AssemblyAI runtime evidence.

Evidence commands run (all in this workspace):

| Check | Result |
|---|---|
| `cd agent && npm run typecheck` | PASS (exit 0) |
| `cd agent && npm run test:transcription` (real SDK, fake room) | PASS 6/6 |
| `npx tsx run-tests.ts transcription` | PASS 75/75 |
| `npx tsx run-tests.ts worker` | PASS 98/98 |
| `npx tsx run-tests.ts realtime` | PASS 30/30 |
| `npx tsx run-tests.ts hardening` | PASS 24/24 |
| `npx tsc --noEmit` (root) | PASS (exit 0) |

---

## Problem 1 — Missing prospect transcription

Pipeline: prospect mic → LiveKit Agent → AssemblyAI STT → LiveKit transcript
event → salesperson transcript panel.

### Stage 1 — Prospect microphone publish: **CONFIRMED**

`lbv-sales-copilot/app/ProspectCall.tsx:199-207` calls
`room.localParticipant.setMicrophoneEnabled(true)` after `room.connect()`, and
the mic is requested last so a denial produces a specific error. The prospect
token is minted `audioOnly`, which grants `canPublishSources: [MICROPHONE]`
(`lbv-sales-copilot/engine/realtime-adapter.ts:302`). Audio-only is enforced.

### Stage 2 — Room/identity contract (Worker ↔ agent): **CONFIRMED**

- `worker.ts` → `POST /api/livekit/invite-token` always mints
  `identity: "prospect"` (~`worker.ts:1208`), display name defaulted to
  `"Prospect"`.
- `agent/agent.ts:60` pins `PROSPECT_IDENTITY = "prospect"`.
- `src/sales/transcriptFilter.ts:29` pins the same literal; the guard test
  (`run-tests.ts transcription`, 75/75) asserts the three agree.

### Stage 3 — Agent dispatch: **RUNTIME-UNVERIFIED**

Evidence the agent was registered/deployed:
- `agent/livekit.toml` exists with real values — project subdomain
  `shopify-execution-fwmg7op6`, agent id `CA_BKGcheiuagZ8`. (The template file
  `agent/livekit.toml.example` states the real file is only produced by LiveKit
  Cloud on first registration.)
- `.github/workflows/deploy-agent.yml` is installed (not only staged under
  `agent/deploy/`).

Dispatch mode is automatic and correct **in code**: `agent/agent.ts:338-343`
passes no `agentName` (`LIVEKIT_AGENT_ROOM` unset), and LiveKit's documented
behaviour is "When `agent_name` is not set, an agent is automatically dispatched
to each new room". The agent logs its own dispatch evidence
(`ctx.job.agentName`) at `agent/agent.ts:181-187`.

### Stage 4 — AssemblyAI runtime configuration: **RUNTIME-UNVERIFIED (highest risk)**

- `agent/agent.ts:150` — `requireEnv("ASSEMBLYAI_API_KEY")` is the **first
  statement of `entry`**. A missing LiveKit Cloud agent secret throws before
  `session.start()`, so the job fails and produces **zero** transcription while
  the deployment itself still reports healthy. This is exactly the
  "silent-failure shape" the file's own comments warn about.
- Model pin is **valid**: `DEFAULT_ASSEMBLYAI_SPEECH_MODEL =
  "universal-streaming-english"` (`agent/agent.ts:76`) is present in the
  installed plugin's `STTModels` union
  (`agent/node_modules/@livekit/agents-plugin-assemblyai/dist/models.d.ts`).
- The claim that the plugin's own default differs is **accurate**: the installed
  `dist/stt.js:101` defaults `speechModel: "universal-3-5-pro"`, a U3-Pro model
  (`U3_PRO_MODELS`, `dist/stt.js:19`).
- Free-tier concurrency/entitlement limits are documented in `DEPLOYMENT.md` §19C
  as a required account setting.

**Not verified:** whether the LiveKit Cloud agent secret list actually contains
`ASSEMBLYAI_API_KEY`, and whether the project's AssemblyAI account is entitled
to the pinned model at the required concurrency.

### Stage 5 — Prospect audio subscription (agent side): **CONFIRMED in code, RUNTIME-UNVERIFIED in production**

- The pin is honoured by the installed SDK: `room_io.js:106` resolves
  `participantIdentity` from `inputOptions.participantIdentity`, and
  `room_io/_input.js:226` refuses to attach any microphone track whose publisher
  is not the linked participant.
- Executed proof: `agent/tests/roomio-transcription.integration.ts` drives the
  real SDK and passes 6/6, including "session links to the prospect even though
  the salesperson joined first" and "published transcription carries the prospect
  microphone track SID".
- The agent logs credential-free positive evidence when it happens:
  `track subscribed: participant=<identity> sid=<sid> source=<source>`
  (`agent/agent.ts:212-220`) plus a 20 s watchdog that distinguishes "no prospect
  mic track" from "audio arrived but STT produced nothing"
  (`agent/agent.ts:309-324`).

**Not verified:** that a production job ever logged `track subscribed:
participant=prospect ... source=MICROPHONE`.

### Stage 6 — Transcript publication: **CONFIRMED in code and by SDK test**

The agent's `outputOptions: { audioEnabled: false }` does **not** disable
transcription — the two are independent in the installed SDK:

- `voice/room_io/room_io.js:415` gates the audio output on
  `outputOptions.audioEnabled`.
- `voice/room_io/room_io.js:424` gates the transcription output on
  `outputOptions.transcriptionEnabled`, whose default is `true`
  (`room_io.js:60`).
- `createTranscriptionOutput` (`room_io.js:297-311`) returns a
  `ParalellTextOutput` that publishes **both** the legacy
  `localParticipant.publishTranscription({ participantIdentity, trackSid, ... })`
  (`room_io/_output.js:306-325`) **and** the newer `lk.transcription` text stream
  (`room_io/_output.js:202-224`).
- Constant agreement is exact: SDK `TOPIC_TRANSCRIPTION = "lk.transcription"`,
  `ATTRIBUTE_TRANSCRIPTION_FINAL = "lk.transcription_final"`,
  `ATTRIBUTE_TRANSCRIPTION_TRACK_ID = "lk.transcribed_track_id"`
  (`agent/node_modules/@livekit/agents/dist/constants.js:1-4`).


**Not verified:** that the deployed agent is `Running` and that it actually
received a job for a sales room. `DEPLOYMENT.md` §18b and §20 step 12 say this
explicitly: "Until that is observed, speech-to-text must be treated as

### Stage 7 — Frontend filtering: **legacy path CONFIRMED, text-stream path FAILED**

**Legacy path (`RoomEvent.TranscriptionReceived`) — CONFIRMED working.**
`livekit-client@2.22.3` `Room.handleTranscription`
(`node_modules/livekit-client/src/room/Room.ts:2176-2191`) resolves the event's
participant from `transcription.transcribedParticipantIdentity` — i.e. the
**speaker** (`"prospect"`), not the publisher. It then emits
`RoomEvent.TranscriptionReceived(segments, participant, publication)`. The
frontend's precedence rule `participantIdentity || segment.participantIdentity`
(`src/sales/transcriptFilter.ts:86`) therefore passes, and the segment field
names (`final`, `text`) match what `extractTranscriptionSegments` produces.
`RoomEvent.TranscriptionReceived` exists in 2.22.3, so the handler at
`LiveKitSalesRoom.tsx:548-574` is registered.

**Text-stream path (`lk.transcription`) — FAILED (three defects).**
It is registered (`LiveKitSalesRoom.tsx:590-628`) and receives real streams, but
can never forward one:

1. **Wrong identity source.** The handler uses
   `senderIdentity: participantInfo?.identity` (`LiveKitSalesRoom.tsx:596`). In
   `livekit-client` the handler's `participantInfo.identity` is the **data-packet
   sender** — the agent — not the transcribed participant
   (`src/room/data-stream/incoming/IncomingDataStreamManager.ts:215,250,318,352`;
   type `TextStreamHandler = (reader, participantInfo: { identity: string })`,
   `StreamReader.ts:273`). `shouldForwardTranscriptionStream` then fails
   `isProspectIdentity("lbv-agent")` → every prospect stream is dropped and
   counted in the panel's "N filtered" counter.
   The Agents SDK's own `senderIdentity` option cannot fix this: it passes
   `senderIdentity` to `localParticipant.streamText(...)`
   (`room_io/_output.js:220-224`), but `StreamTextOptions` in 2.22.3 has **no**
   `senderIdentity` field (`src/room/types.ts:41-51`) and
   `OutgoingDataStreamManager.streamText` never reads it
   (`OutgoingDataStreamManager.ts:373-390`) — the option is silently discarded.
   The transcribed participant is only recoverable via the
   `lk.transcribed_track_id` attribute, which the frontend never reads.
2. **Wrong segment-id attribute.** `TRANSCRIPTION_ATTR_SEGMENT_ID` is
   `"lk.transcription_segment_id"` (`src/sales/transcriptFilter.ts:38`), but the
   SDK emits `"lk.segment_id"` (`@livekit/agents/dist/constants.js:4`). Even if
   the identity check passed, `transcriptionStreamSegmentId()` would return
   `undefined` and the fallback id would differ from the legacy id, breaking the
   intended cross-path de-duplication.
3. **False-confidence test.** The assertion named "the transcription stream
   attribute names match the Agents SDK constants"
   (`lbv-sales-copilot/validation/transcription-pipeline-tests.ts:299-303`)
   compares the frontend constants to their own literals — it never reads the
   SDK. It passes while the real attribute name is wrong. This is the same class
   of problem the agent's own integration test header calls out ("assertions
   passed while prospect transcription was still broken in production, because
   they restate the intended configuration instead of exercising it").

Impact today: none of the above loses transcription, because the legacy path
delivers the same segments. Impact going forward: LiveKit documents
`TranscriptionReceived`/`publish_transcription()` as **deprecated** ("Migrating
from TranscriptionReceived"), so this dead path is a latent single point of
failure, and the misleading "N filtered" counter actively misleads diagnosis.

unverified."


Verified against the **installed** dependency versions (not the docs):
`livekit-client@2.22.3` (locked in `package-lock.json:2964`),

### Problem 1 — likely root cause

No defect exists in the confirmed stages (prospect mic, identity contract,
participant linking, publication, legacy filtering); all are correct in code and
proven by executed SDK-level tests. The failure must therefore be at one of the
two stages that the repository cannot verify, and the repository itself flags
both:

1. **Most likely — the agent never produces STT audio for the room, because the
   deployed agent is not being dispatched into the sales room at all.**
   The agent's registered project is `shopify-execution-fwmg7op6`
   (`agent/livekit.toml`), while the Worker's `LIVEKIT_URL` is a Cloudflare
   var/secret that is deliberately absent from the repo. A project mismatch (or a
   `create`-only registration whose `deploy` never reached `Running`) produces
   exactly this symptom: the salesperson UI shows the prospect connected and an
   empty transcript, with no error.
2. **Also likely — the agent job fails at `requireEnv("ASSEMBLYAI_API_KEY")`**
   (`agent/agent.ts:150`) because the LiveKit Cloud agent secret was never set
   (e.g. the agent was registered with `lk agent create` rather than through the
   workflow that passes `SECRET_LIST`), or AssemblyAI rejects the streaming
   socket for entitlement/free-tier reasons.

Both produce "healthy deployment, zero transcription", which is why the empty
panel is ambiguous. They are distinguished by one artifact each (below).

### Problem 1 — missing runtime evidence (the discriminators)

| Question | Artifact that answers it |
|---|---|
| Was the agent dispatched, and how? | `lk agent logs` line `[lbv-agent] connected to room <name> ... dispatch=automatic` |
| Did it link to the prospect? | `[lbv-agent] linked participant (session started): prospect (expected: prospect)` |
| Did prospect audio arrive? | `[lbv-agent] track subscribed: participant=prospect sid=... source=MICROPHONE` |
| Did STT produce finals? | `[lbv-agent] final transcript received (chars=...)` or the 20 s watchdog warning |
| Does the agent have its key? | LiveKit Cloud agent secret list / a failed job with `Missing required environment variable: ASSEMBLYAI_API_KEY` |
| Same LiveKit project? | dashboard `LIVEKIT_URL` vs `agent/livekit.toml` `subdomain` |

### Problem 1 — smallest recommended fix

**No application code change is warranted yet** — the confirmed stages are
correct, and changing them would be a guess.

1. Collect the four `lk agent logs` lines above (one live call, `lk agent logs -f`).
   - If the dispatch/connect lines are absent → the cause is dispatch/deployment;
     confirm `LIVEKIT_URL` belongs to the `shopify-execution-fwmg7op6` project,
     and re-run the `deploy` operation. No code change.
   - If `Missing required environment variable: ASSEMBLYAI_API_KEY` appears →
     set the agent secret (`SECRET_LIST`) and redeploy. No code change.
   - If `final transcript received` appears but the panel stays empty → the
     cause is delivery/filtering, and the single smallest code fix is the
     text-stream identity bug in stage 7 (read the transcribed participant from
     `lk.transcribed_track_id` instead of the packet sender).
2. Regardless of outcome, correct the segment-id constant to `lk.segment_id` and
   make the "matches the Agents SDK constants" test read the installed SDK
   instead of restating the literals — this is a 2-line change plus a test fix
   and is the only defect proven by evidence so far.

`@livekit/agents@1.9.2`, `@livekit/agents-plugin-assemblyai@1.9.2`
(`agent/package-lock.json:1011`).


---

## Problem 2 — Audio interruptions and latency (> 2 s)

Separated into (A) audio transport, (B) STT finalization, (C) AI recommendation.

### Measured facts (from code and executed tests)

**C — AI recommendation latency is fully buffered behind a streaming endpoint.**

`generateRecommendationStream` (`lbv-sales-copilot/engine/generic-sales-engine.ts:538-548`)
does **not** stream model tokens:

```ts
const recommendation = await this.generateRecommendation(prospectPrompt, adapterOrOptions);
for (const chunk of GenericSalesEngine.chunkForStreaming(recommendation.statement || "")) {
  onValidatedDelta(chunk);
}
```

It awaits the *complete* `generateRecommendation` first, then emits the already
validated statement in 5-word chunks. The SSE route (`worker.ts:1308-1390`)
therefore emits `status: analyzing` immediately but its first `delta` only after
the whole model pipeline finishes. **The SSE path provides no
time-to-first-token benefit at all**; it is a cosmetic stream of a finished
string. The UI's "Analyzing the prospect's statement through the compliance
gate…" spinner covers the entire pipeline.

**C — the pipeline is 1–3 sequential model round-trips, each with a 20 s ceiling.**

`generateRecommendation` (`generic-sales-engine.ts:232-527`):
1. `invokeModel` — turn 1 (`:306-310`).
2. If the model requests tools: a second `invokeModel` — turn 2 (`:369-373`).
3. If the deterministic approval gate rejects the statement: a bounded-recovery
   `invokeModel` — turn 3 (`:406-410`).

Each call is a Groq chat completion with `timeoutMs` defaulting to **20000 ms**
(`llm/groq-provider.ts:54`; `LLM_TIMEOUT_MS` default documented in
`DEPLOYMENT.md` §19A) on the default model `llama-3.1-8b-instant`
(`groq-provider.ts:53`). Worst case is therefore three sequential calls up to
20 s each before a single character reaches the panel. `engineMetadata` records
`latencyMs`, `modelExecutionMs`, `approvalGateMs`, `turnsCount`,
`recoveryAttempts` (`generic-sales-engine.ts:472-484`).

**C — the frontend cancels the in-flight recommendation on every new final
segment.** `processProspectTranscript` begins with
`activeAbortRef.current?.abort()` (`LiveKitSalesRoom.tsx:294-296`). During
continuous prospect speech, each new final segment aborts the previous
`/api/livekit/transcript/stream` request, discarding the LLM work already paid
for and restarting the 1–3-call pipeline. The panel can therefore appear to never
settle, which reads as "interruption" even though audio is unaffected.

**B — STT finalization is the start of the clock, by design.**
Only final segments are forwarded (`src/sales/transcriptFilter.ts:80-87`), and
the AssemblyAI plugin emits `FINAL_TRANSCRIPT` only on `end_of_turn`
(`plugins/assemblyai/src/stt.ts`), i.e. after AssemblyAI's end-of-turn detection
fires. So every recommendation inherently waits for end-of-turn silence, then the
network round-trip, then (C).

**A/B/C — no latency instrument is retained in production.**
The Worker returns `engineMetadata` in both the buffered and SSE `final` events,
but `processProspectTranscript` reads only `statement` and `status`
(`LiveKitSalesRoom.tsx:349-358`) and discards `engineMetadata`. Nothing logs or
stores the STT-vs-transport-vs-LLM split. The engine's server-side `latencyMs` is
also only in the response body, not in a durable log.


### Hypotheses (NOT measured — no transport telemetry available)

- **A — audio transport jitter/interruption.** No jitter-buffer, bitrate, or
  codec tuning exists anywhere: both clients construct `new Room({
  adaptiveStream: true, dynacast: true, audioCaptureDefaults: {...} })`
  (`LiveKitSalesRoom.tsx:487-491`, `ProspectCall.tsx:157-165`). `adaptiveStream`
  and `dynacast` are video features; neither helps nor hurts audio. There is no
  `publishDefaults` audio configuration and no region pinning, so transport
  quality is whatever LiveKit Cloud negotiates for the participants' networks.
  LiveKit Cloud room metrics (RTT, jitter, packet loss, codec) are required to
  confirm or refute this and are not available in the repository.
- **A — free-plan agent CPU contention.** `DEPLOYMENT.md` §18b documents that on
  the Build plan agents scale to zero when idle (first call waits 10–20 s) and
  roll out with a rolling strategy. The same container runs Silero VAD plus the
  AssemblyAI WebSocket client (`agent/agent.ts:146,151,197-203`), so an
  under-provisioned instance can delay STT and lengthen end-of-turn latency. The
  repository contains no resource limits or measurements.
- **A — client main-thread load.** The salesperson page parses SSE frames,
  updates transcript and recommendation state, and re-renders per segment. The
  audio path itself is imperative (elements held in `audioElementsRef`, not in
  JSX), so React re-renders do not detach audio; `participantsEqual`
  (`LiveKitSalesRoom.tsx:74-86`) already suppresses needless re-renders on
  `ActiveSpeakersChanged`. Low-probability contributor.
- **Eliminated hypothesis — agent-side audio.** `outputOptions: { audioEnabled:
  false }` (`agent/agent.ts:292`) prevents the agent from publishing an output
  track (`room_io.js:415`), so the agent cannot cause echo or an extra negotiated
  media section.

### Problem 2 — likely root cause

**The > 2 s figure is explained by (B) + (C), not by audio transport.** The
recommendation clock cannot start until AssemblyAI declares end-of-turn, and from
there the request is served by a pipeline that (i) is fully buffered behind an
endpoint that only appears to stream, (ii) may require up to three sequential
20 s-capped Groq calls, and (iii) is aborted and restarted by the next final
segment during continuous speech. That is a design-level latency budget, not a
regression, and it is the only latency claim supported by evidence in the repo.

**Audio jitter/interruption (A) has no supporting evidence in the repository and
must not be attributed yet.** The candidates are network/region, free-plan agent
resource contention, and client main-thread load; distinguishing them requires
LiveKit Cloud room metrics and agent logs, which are absent.

### Problem 2 — missing runtime evidence

1. LiveKit Cloud room metrics per call: RTT, jitter, packet loss, audio codec, and
   any `Reconnecting`/`TrackUnsubscribed` events on either client. This is the
   only way to accept or reject (A).
2. The `engineMetadata` values (`latencyMs`, `modelExecutionMs`,
   `approvalGateMs`, `turnsCount`, `recoveryAttempts`) for real calls — already
   produced by the server, currently discarded by the client.
3. Agent logs showing whether the 20 s watchdog fired and whether STT produced
   finals promptly (`[lbv-agent] final transcript received (chars=...)`).
4. AssemblyAI end-of-turn timing for the pinned `universal-streaming-english`
   model (provider-side; not in the repo).

### Problem 2 — smallest recommended fix

**No code change is required to establish the facts, and none is recommended
until the measurement exists.** The smallest step that makes the latency split
measurable is a client-side instrumentation change of a few lines: retain
`engineMetadata` from the SSE `final` event (`LiveKitSalesRoom.tsx:349-358`)
alongside a `performance.now()` timestamp taken when the final segment arrives,
and log the three numbers. That single change separates STT-finalization latency
from recommendation latency using data the backend already sends.

If the measurement then shows (C) dominates, the smallest effective change is to
make the SSE route actually stream — i.e. have the engine emit validated text as
it is produced rather than after the whole pipeline — which changes the approval
gate's sequencing and therefore needs explicit approval before it is attempted.
If (A) dominates, the fix is transport/region configuration in LiveKit Cloud, not
application code.

---

## Explicitly not done (per constraints)

No architecture redesign, no credential changes, no new LiveKit Agent or
Cloudflare Worker, and no changes to two-way audio, participant isolation,
approval gates, or security. No application source file was modified by this
investigation; the only file added is this report.
