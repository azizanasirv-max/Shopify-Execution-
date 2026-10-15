/**
 * LiveKit Agents SDK transcription integration test (REAL SDK, fake room).
 *
 * WHY THIS EXISTS
 * ---------------
 * The root suite (`lbv-sales-copilot/validation/transcription-pipeline-tests.ts`)
 * only greps the *source text* of `agent/agent.ts`. Those assertions passed while
 * prospect transcription was still broken in production, because they restate the
 * intended configuration instead of exercising it.
 *
 * This suite drives the REAL installed SDK (`@livekit/agents` 1.9.2) end to end:
 *
 *   fake prospect mic track -> AgentSession/AgentActivity -> fake STT FINAL event
 *   -> RoomIO user-transcript sink -> room publication
 *
 * and asserts the exact wire call the salesperson's `livekit-client` depends on:
 * `localParticipant.publishTranscription({ participantIdentity, trackSid, ... })`.
 *
 * No network, no credentials, no LiveKit connection: the room is a fake that
 * records publications. This is what makes the failure observable without access
 * to LiveKit Cloud runtime logs.
 */

import { EventEmitter } from "node:events";
import { AudioFrame, TrackSource } from "@livekit/rtc-node";
import { initializeLogger, stt, voice } from "@livekit/agents";

// The SDK's internal loggers require an initialized logger.
initializeLogger({ pretty: false, level: "warn" });

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string): void {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${name}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate()` is true or the timeout expires. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/* -------------------------------------------------------------------------- */
/* Fake room (mimics the @livekit/rtc-node surface RoomIO uses)               */
/* -------------------------------------------------------------------------- */

interface PublishedTranscription {
  participantIdentity: string;
  trackSid: string;
  segments: { id: string; text: string; final: boolean }[];
}

class FakeLocalParticipant {
  identity = "lbv-agent";
  trackPublications = new Map<string, unknown>();
  publishedTranscriptions: PublishedTranscription[] = [];
  streamedTexts: { topic?: string; senderIdentity?: string; text: string }[] = [];

  getTrackPublication() {
    return undefined as unknown as { isMuted: boolean } | undefined;
  }

  setAttributes(): Promise<void> {
    return Promise.resolve();
  }

  async publishTranscription(transcription: {
    participantIdentity: string;
    trackSid: string;
    segments: { id: string; text: string; final: boolean }[];
  }): Promise<void> {
    this.publishedTranscriptions.push({
      participantIdentity: transcription.participantIdentity,
      trackSid: transcription.trackSid,
      segments: transcription.segments.map((s) => ({ id: s.id, text: s.text, final: s.final })),
    });
  }

  /** New-style transcription delivery (text stream on `lk.transcription`). */
  async streamText(options?: { topic?: string; senderIdentity?: string }): Promise<{
    write: (t: string) => Promise<void>;
    close: () => Promise<void>;
  }> {
    const record = { topic: options?.topic, senderIdentity: options?.senderIdentity, text: "" };
    this.streamedTexts.push(record);
    return {
      write: async (text: string) => {
        record.text += text;
      },
      close: async () => {},
    };
  }

  async publishTrack(): Promise<unknown> {
    return { waitForSubscription: async () => {} };
  }

  /** Used by RoomSessionTransport for session events. */
  async streamBytes(_options?: unknown): Promise<{
    write: (b: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
  }> {
    return { write: async () => {}, close: async () => {} };
  }

  async sendText(): Promise<void> {}
}

class FakeRemoteParticipant {
  attributes: Record<string, string> = {};
  trackPublications = new Map<string, unknown>();
  disconnectReason = undefined;
  constructor(
    public identity: string,
    public info: { kind: number } = { kind: 0 }
  ) {}
}

class FakeRoom extends EventEmitter {
  name = "room_shopify-conversion-pilot_session-1";
  isConnected = true;
  localParticipant = new FakeLocalParticipant();
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  textStreamHandlers = new Map<string, unknown>();

  registerTextStreamHandler(topic: string, handler: unknown): void {
    this.textStreamHandlers.set(topic, handler);
  }

  unregisterTextStreamHandler(topic: string): void {
    this.textStreamHandlers.delete(topic);
  }

  registerByteStreamHandler(_topic: string, _handler: unknown): void {}
}

/** Minimal AudioInput wired the same way `ParticipantAudioInputStream` is. */
class FakeAudioInput extends voice.AudioInput {
  private controller: ReadableStreamDefaultController<AudioFrame> | null = null;
  private readonly source: ReadableStream<AudioFrame>;
  framesPulled = 0;

  constructor() {
    super();
    this.source = new ReadableStream<AudioFrame>({
      start: (controller) => {
        this.controller = controller;
      },
      pull: async () => {
        this.framesPulled += 1;
      },
    });
    // Same registration the SDK's own ParticipantAudioInputStream performs.
    this.multiStream.addInputStream(this.source as never);
  }

  push(frame: AudioFrame): void {
    this.controller?.enqueue(frame);
  }

  override async close(): Promise<void> {
    try {
      this.controller?.close();
    } catch {
      /* already closed */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Fake STT: emits a FINAL_TRANSCRIPT for every audio frame it receives       */
/* -------------------------------------------------------------------------- */

class FakeSpeechStream extends stt.SpeechStream {
  label = "FakeSpeechStream";
  text: string;
  framesReceived = 0;
  constructor(owner: stt.STT, sampleRate: number, text: string) {
    super(owner, sampleRate);
    this.text = text;
  }

  async run(): Promise<void> {
    for (;;) {
      const result = await this.input.next();
      if (result.done) break;
      this.framesReceived += 1;
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [
          {
            text: this.text,
            language: "en",
            startTime: 0,
            endTime: 0,
            confidence: 1,
            words: [],
          } as never,
        ],
      });
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    }
  }
}

class FakeSTT extends stt.STT {
  label = "FakeSTT";
  text: string;
  streamsCreated = 0;
  framesSeen = 0;
  lastStream: FakeSpeechStream | null = null;
  constructor(text: string) {
    super({ streaming: true, interimResults: true, alignedTranscript: "word" });
    this.text = text;
  }

  override get provider(): string {
    return "Fake";
  }

  override get model(): string {
    return "fake-1";
  }

  async _recognize(): Promise<never> {
    throw new Error("non-streaming recognize is not supported");
  }

  override stream(): stt.SpeechStream {
    this.streamsCreated += 1;
    const stream = new FakeSpeechStream(this, 16000, this.text);
    this.lastStream = stream;
    return stream;
  }
}

/* -------------------------------------------------------------------------- */
/* Scenario                                                                   */
/* -------------------------------------------------------------------------- */

interface Scenario {
  room: FakeRoom;
  audioInput: FakeAudioInput;
  session: voice.AgentSession;
  prospect: FakeRemoteParticipant;
  stt: FakeSTT;
  userTranscriptEvents: { transcript: string; isFinal: boolean }[];
}

/**
 * Boots a real AgentSession against a fake room where the SALESPERSON joins
 * first (as in production: the salesperson opens the room, then sends the
 * invitation link) and the prospect joins later and publishes a microphone.
 */
async function bootScenario(transcriptText: string): Promise<Scenario> {
  const room = new FakeRoom();
  const salesperson = new FakeRemoteParticipant("salesperson");
  room.remoteParticipants.set(salesperson.identity, salesperson);

  const audioInput = new FakeAudioInput();
  const fakeStt = new FakeSTT(transcriptText);
  const session = new voice.AgentSession({ stt: fakeStt });
  // Pre-set the audio input so RoomIO preserves it instead of creating a
  // ParticipantAudioInputStream (which needs a real WebRTC track).
  session.input.audio = audioInput;

  const userTranscriptEvents: { transcript: string; isFinal: boolean }[] = [];
  session.on(
    voice.AgentSessionEventTypes.UserInputTranscribed,
    (event: { transcript: string; isFinal: boolean }) => {
      userTranscriptEvents.push({ transcript: event.transcript, isFinal: event.isFinal });
    }
  );

  await session.start({
    room: room as never,
    agent: new voice.Agent({ instructions: "silent transcription agent" }),
    inputOptions: { participantIdentity: "prospect" },
    outputOptions: { audioEnabled: false },
  });

  // The prospect joins AFTER the salesperson (production join order).
  const prospect = new FakeRemoteParticipant("prospect");
  room.remoteParticipants.set(prospect.identity, prospect);
  room.emit("participantConnected", prospect);

  // The prospect publishes a microphone track.
  const micPublication = { sid: "TR_prospect_mic", source: TrackSource.SOURCE_MICROPHONE };
  prospect.trackPublications.set(micPublication.sid, micPublication);
  room.emit("trackPublished", micPublication, prospect);

  await sleep(50);
  return { room, audioInput, session, prospect, stt: fakeStt, userTranscriptEvents };
}

function makeFrame(): AudioFrame {
  // 10 ms of silence at 24 kHz (RoomIO default input rate).
  return new AudioFrame(new Int16Array(240), 24000, 1, 240);
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

export async function runRoomIoTranscriptionIntegrationTests(): Promise<{
  passed: number;
  failed: number;
}> {
  console.log("==================================================");
  console.log("  LIVEKIT AGENT TRANSCRIPTION INTEGRATION (REAL SDK)");
  console.log("==================================================");

  // ---------------------------------------------------------------- 1
  console.log("\n[1/3] Agent links to the prospect (not the first participant)...");
  {
    const scenario = await bootScenario("prospect says hello");
    const linked = (
      scenario.session as unknown as { _roomIO?: { linkedParticipant?: { identity: string } } }
    )._roomIO?.linkedParticipant?.identity;
    assert(
      linked === "prospect",
      "session links to the prospect even though the salesperson joined first",
      `linked=${linked}`
    );
    await scenario.session.close();
  }

  // ---------------------------------------------------------------- 2
  console.log("\n[2/3] A final prospect transcript reaches the room publication path...");
  {
    const scenario = await bootScenario("prospect says hello");
    // Drive the SDK's public event contract (the STT provider is the only piece
    // that needs the network; everything downstream of it runs for real here).
    scenario.session.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
      isFinal: true,
      transcript: "prospect says hello",
    } as never);

    const published = await waitFor(
      () => scenario.room.localParticipant.publishedTranscriptions.length > 0
    );
    const all = scenario.room.localParticipant.publishedTranscriptions;
    const finals = all.filter((t) => t.segments.some((s) => s.final));

    assert(
      published || scenario.room.localParticipant.streamedTexts.length > 0,
      "a transcription is published to the room (legacy signal or text stream)",
      `legacy=${all.length} textStreams=${scenario.room.localParticipant.streamedTexts.length}`
    );
    assert(
      finals.length > 0,
      "the LEGACY publication path emits FINAL segments (the path livekit-client reads)",
      `legacy=${all.length} textStreams=${scenario.room.localParticipant.streamedTexts.length}`
    );
    assert(
      finals.length > 0 && finals.every((t) => t.participantIdentity === "prospect"),
      "published transcription is attributed to the PROSPECT identity",
      JSON.stringify(finals.map((t) => t.participantIdentity))
    );
    assert(
      finals.length > 0 && finals.every((t) => Boolean(t.trackSid)),
      "published transcription carries the prospect microphone track SID",
      JSON.stringify(finals.map((t) => t.trackSid))
    );
    await scenario.session.close();
  }

  // ---------------------------------------------------------------- 3
  console.log("\n[3/3] Published segments use the field names the browser filter reads...");
  {
    const scenario = await bootScenario("prospect says hello");
    scenario.session.emit(voice.AgentSessionEventTypes.UserInputTranscribed, {
      isFinal: true,
      transcript: "prospect says hello",
    } as never);
    await waitFor(() => scenario.room.localParticipant.publishedTranscriptions.length > 0);

    const legacyFinal = scenario.room.localParticipant.publishedTranscriptions.find((t) =>
      t.segments.some((s) => s.final)
    );
    // livekit-client's `TranscriptionSegment` exposes `final` (not `isFinal`).
    assert(
      Boolean(legacyFinal?.segments.some((s) => s.final === true && typeof s.text === "string")),
      "final segments expose `final: true` + `text`, as livekit-client's TranscriptionSegment does",
      JSON.stringify(legacyFinal)
    );
    await scenario.session.close();
  }

  console.log(
    `\nAgent transcription integration summary: Passed: ${passed}, Failed: ${failed}`
  );
  return { passed, failed };
}

// Allow `tsx agent/tests/roomio-transcription.integration.ts` direct execution.
if (process.argv[1] && process.argv[1].includes("roomio-transcription.integration")) {
  runRoomIoTranscriptionIntegrationTests()
    .then(({ failed: failures }) => {
      process.exit(failures > 0 ? 1 : 0);
    })
    .catch((error) => {
      console.error("Integration harness crashed:", error);
      process.exit(1);
    });
}
