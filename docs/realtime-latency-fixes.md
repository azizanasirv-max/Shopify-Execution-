# Realtime interruptions + conversational latency — fixes applied

Scope: audio path stability and recommendation latency only. The AssemblyAI
transcription pipeline, transcript filtering, and participant-identity handling
were NOT touched.

## 1. Confirmed causes

### Interruptions (audio path)

| # | Cause | Evidence |
|---|---|---|
| I1 | **Blocked remote-audio playback was undetected and unrecoverable.** `Room.startAudio()` was called once inside a swallow-all `try/catch`; neither client subscribed to `RoomEvent.AudioPlaybackStatusChanged`, and `Room.canPlaybackAudio` was never read. When the browser refuses autoplay (common after a reconnect or a backgrounded tab), remote audio is silent and the UI says nothing. | `livekit-client@2.22.3` `src/room/events.ts:293` documents `AudioPlaybackStatusChanged` + `Room.canPlaybackAudio`; `Room.startAudio()` at `Room.ts:1344`. Neither event nor getter appeared anywhere in the app. |
| I2 | **Join was not idempotent.** `handleJoinRoom` had no ref guard; the only protection was the button's `disabled` prop, which applies on the *next* render. A fast double activation builds a second `Room` and publishes a second microphone track for the same identity → duplicated/echoing audio. | `LiveKitSalesRoom.tsx` `handleJoinRoom` (old) had no guard, while `ProspectCall.tsx` already used `joiningRef`. |
| I3 | **Audio elements were never reconciled.** `TrackSubscribed` overwrote the map entry for an identity without detaching the previous track; `Disconnected` never cleared the map; `ProspectCall` left detached elements in the DOM. `Track.detach()` recycles elements into a global pool and `Track.attach()` reuses pooled elements, so a leaked element can carry a live `srcObject`. | `livekit-client` `src/room/track/Track.ts:145-167` (recycle on `attach`) and `:228-240` (`detach` → `recycleElement`). |
| I4 | **No transport-health evidence existed.** No `Reconnecting` / `Reconnected` / `ConnectionQualityChanged` handling, so jitter and reconnect windows could not be attributed after the fact. | Absent from both clients; events exist at `src/room/events.ts:21,33,252`. |

### Latency (recommendation path)

| # | Cause | Evidence |
|---|---|---|
| L1 | **The "streaming" endpoint never streamed.** `generateRecommendationStream` awaited the whole `generateRecommendation` and only then chunked the finished string. | `generic-sales-engine.ts:538-548`. |
| L2 | **Every new final segment cancelled the in-flight request.** `activeAbortRef.current?.abort()` ran unconditionally. A short backchannel ("yeah") arriving while a valuable recommendation was generating destroyed that request, so the salesperson got no guidance for the substantive sentence. | Old `processProspectTranscript` (`LiveKitSalesRoom.tsx`). |
| L3 | **The fallback issued a second, guaranteed-useless model pipeline.** The client fell back to the buffered route whenever nothing had rendered — including after a terminal `final` with `recommendation: null` (duplicate or non-actionable). The server's dedupe guard then answered the fallback with `duplicate: true`, so the user saw nothing while paying for two pipelines. | Old client + `worker.ts` `isDuplicateTranscript`. |
| L4 | **`engineMetadata` was discarded**, so the server-side split (`latencyMs`, `modelExecutionMs`, `approvalGateMs`, `turnsCount`) was never visible. | Client read only `statement`/`status`. |
| L5 | **Backchannels reached the model.** Deterministic routing (`decideRouting`) was wired into `handleRealtimeTranscript` only; the HTTP transcript routes called `generateRecommendation` directly, so "mm-hmm"/"ok" bought a full model pipeline. | `generic-sales-engine.ts:597` vs `worker.ts` transcript routes. |

## 2. Fixes implemented

- **`src/sales/recommendationClient.ts` (new)** — the request lifecycle extracted
  from the component so it is unit-testable (same rationale as
  `transcriptFilter.ts`). Contains `RecommendationScheduler` (coalesce identical
  in-flight text; never cancel on a newer segment; cancel only the oldest at the
  2-request cap; `abortAll` on teardown) and `requestRecommendation` (SSE first,
  buffered fallback only when no terminal `final` frame arrived; preserves
  `engineMetadata`; measures `transcriptToFirstVisibleMs`).
- **`LiveKitSalesRoom.tsx`** — uses the new module; surfaces the measured
  latency + server breakdown under the recommendation; detects and recovers
  blocked audio playback (`AudioPlaybackStatusChanged` + `canPlaybackAudio` +
  an "Enable audio" gesture button); observes `Reconnecting` / `Reconnected` /
  `ConnectionQualityChanged` with timestamped diagnostics and a "poor
  connection" notice; reconciles audio elements (`attachRemoteAudio` /
  `releaseRemoteAudio`) and clears them on disconnect; idempotent join.
- **`ProspectCall.tsx`** — blocked-playback detection + recovery button; audio
  elements removed from the DOM on unsubscribe (stops accumulation across
  reconnects).
- **`generic-sales-engine.ts`** — `shouldInvokeModel(text)` exposes the existing
  deterministic routing decision.
- **`worker.ts`** — both transcript routes skip the model pipeline for
  non-actionable utterances (`skipped: "non_actionable"`, `recommendation: null`).
- **`realtime-latency-tests.ts` (new)** + `npm run test:latency`, included in the
  `hardening` aggregate so CI (`npm test`) covers it.

Approval gates, validation, participant isolation, credentials, and the agent
were not modified.
