/**
 * LBV Sales Engine - LiveKit Agent with DIRECT AssemblyAI speech-to-text.
 *
 * PURPOSE
 * -------
 * The Cloudflare Worker cannot run speech-to-text. This long-running agent joins
 * the LiveKit room used by the sales call, streams room audio to the DIRECT
 * AssemblyAI API (your own AssemblyAI key / free-tier allowance - NOT LiveKit
 * Inference billing), and publishes transcription events into the room.
 *
 * The existing salesperson UI (`lbv-sales-copilot/app/LiveKitSalesRoom.tsx`)
 * already listens for `RoomEvent.TranscriptionReceived`, filters FINAL PROSPECT
 * segments, and POSTs them to the Worker's transcript endpoint.
 *
 * PARTICIPANT LINKING (critical)
 * ------------------------------
 * The LiveKit Agents SDK links an `AgentSession` to exactly ONE participant and
 * feeds ONLY that participant's microphone to STT. `RoomInputOptions` documents
 * this as: "The participant to link to. If not provided, link to the FIRST
 * participant." Because the salesperson joins the room before the prospect opens
 * the invitation link, omitting it linked the session to the SALESPERSON: the
 * prospect's audio never reached AssemblyAI, and the (salesperson) transcription
 * that was produced was published under the `salesperson` identity, which the
 * salesperson UI's prospect-only filter discards. `inputOptions.participantIdentity`
 * below pins the link to the prospect, whose identity the Worker fixes to the
 * literal string "prospect" (worker.ts -> POST /api/livekit/invite-token).
 *
 * RUN
 * ---
 *   cd agent && npm install && npm run dev
 *
 * REQUIRED ENVIRONMENT (see agent/.env.example): LIVEKIT_URL, LIVEKIT_API_KEY,
 * LIVEKIT_API_SECRET, ASSEMBLYAI_API_KEY.
 *
 * NOTE: this file is intentionally excluded from the root tsconfig so the main
 * application's CI does not need the agent dependencies installed. Verify it with
 * `cd agent && npm run typecheck` after installing agent dependencies.
 */

import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  log,
  voice,
} from "@livekit/agents";
import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import * as silero from "@livekit/agents-plugin-silero";

/**
 * The LiveKit identity the Worker issues to the prospect.
 *
 * MUST match `worker.ts` -> `POST /api/livekit/invite-token`, which always mints
 * the prospect token with `identity: "prospect"` (the salesperson is
 * "salesperson"). A regression test guards this contract - see
 * `lbv-sales-copilot/validation/transcription-pipeline-tests.ts`.
 */
const PROSPECT_IDENTITY = "prospect";

/**
 * AssemblyAI streaming speech model used when `ASSEMBLYAI_SPEECH_MODEL` is unset.
 *
 * PINNED ON PURPOSE. The installed plugin
 * (`@livekit/agents-plugin-assemblyai` 1.9.2) defaults to `universal-3-5-pro`,
 * a U3-Pro streaming model. That is NOT the model this repository documents
 * (`agent/.env.example`, `DEPLOYMENT.md`: "default: universal-streaming-english")
 * and U3-Pro entitlement is not guaranteed for the project's AssemblyAI account.
 * An unentitled / unknown model makes AssemblyAI reject the streaming WebSocket,
 * which yields ZERO transcription while the agent still reports healthy - the
 * exact silent-failure shape this pipeline must not have. Pinning the model makes
 * the behaviour match the documentation and the startup log makes it observable.
 * Override with `ASSEMBLYAI_SPEECH_MODEL` when a different model is entitled.
 */
const DEFAULT_ASSEMBLYAI_SPEECH_MODEL = "universal-streaming-english";

/** Resolve the effective AssemblyAI model (env override wins). */
function resolveSpeechModel(): string {
  const override = process.env.ASSEMBLYAI_SPEECH_MODEL?.trim();
  return override || DEFAULT_ASSEMBLYAI_SPEECH_MODEL;
}

/**
 * How long to wait after the prospect's microphone track is published before
 * reporting that no final transcript has been produced yet. Credential-free and
 * content-free: it only distinguishes "STT produced nothing" from "the agent
 * never saw prospect audio", which the salesperson's empty panel cannot.
 */
const NO_TRANSCRIPT_WARN_MS = 20000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[lbv-agent] Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Resolve the effective agent name exactly the way the SDK does, so the dispatch
 * mode is observable in the logs without credentials or dashboard access.
 *
 * Resolution order (@livekit/agents WorkerOptions.agentName / worker.js):
 *   1. LIVEKIT_AGENT_NAME_OVERRIDE
 *   2. the explicit `agentName` option (here sourced from LIVEKIT_AGENT_ROOM)
 *   3. LIVEKIT_AGENT_NAME
 *   4. otherwise "" -> AUTOMATIC dispatch (the worker joins every new room)
 *
 * A non-empty agent name enables EXPLICIT dispatch, so the agent is NOT
 * dispatched automatically. The Worker mints plain participant tokens and never
 * dispatches agents, so a non-empty name here would leave the agent idle and
 * produce no transcription at all.
 */
function resolveAgentName(): string {
  return (
    process.env.LIVEKIT_AGENT_NAME_OVERRIDE ||
    process.env.LIVEKIT_AGENT_ROOM ||
    process.env.LIVEKIT_AGENT_NAME ||
    ""
  );
}

/** Credential-free startup diagnostic: which dispatch mode will be used. */
function logDispatchMode(): void {
  const agentName = resolveAgentName();
  if (agentName) {
    log().warn(
      `[lbv-agent] dispatch=EXPLICIT agentName=${agentName}. Explicit dispatch is enabled, so this ` +
        `worker will NOT join rooms automatically and the Worker never dispatches agents. ` +
        `Unset LIVEKIT_AGENT_NAME_OVERRIDE / LIVEKIT_AGENT_ROOM / LIVEKIT_AGENT_NAME for automatic dispatch.`
    );
  } else {
    log().info(
      "[lbv-agent] dispatch=AUTOMATIC (no agent name configured; the worker joins every new room)"
    );
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Runs once per worker process - before (and even without) any job - so the
    // dispatch mode is always visible in the logs.
    logDispatchMode();
    // Load the VAD once per process; it is reused across jobs.
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const assemblyAiKey = requireEnv("ASSEMBLYAI_API_KEY");
    const vad = (ctx.proc.userData.vad as silero.VAD) ?? (await silero.VAD.load());

    // --- Diagnostics: connection / participants (credential-free) --------------
    // Only participant IDENTITIES are logged ("prospect" / "salesperson"): they
    // are role labels, never secrets, tokens, or transcript content.
    const participantIds = () =>
      [...ctx.room.remoteParticipants.keys()].join(",") || "(none)";

    ctx.room.on("participantConnected", (participant) => {
      log().info(
        `[lbv-agent] participant connected: ${participant.identity} (room participants: ${participantIds()})`
      );
    });

    ctx.room.on("participantDisconnected", (participant) => {
      log().info(
        `[lbv-agent] participant disconnected: ${participant.identity} (room participants: ${participantIds()})`
      );
    });

    ctx.room.on("trackPublished", (publication, participant) => {
      log().info(
        `[lbv-agent] track published: participant=${participant.identity} source=${publication.source}`
      );
    });

    await ctx.connect();
    // `ctx.job.agentName` is the server-provided dispatch name: empty means the
    // job was delivered by AUTOMATIC dispatch. This is the authoritative,
    // credential-free evidence of how the agent was dispatched.
    const jobAgentName = ctx.job?.agentName || "";
    log().info(
      `[lbv-agent] connected to room ${ctx.room.name} job=${ctx.job?.id ?? "n/a"} ` +
        `dispatch=${jobAgentName ? `explicit(${jobAgentName})` : "automatic"} ` +
        `dispatchParticipant=${ctx.job?.participant?.identity ?? "(none)"} ` +
        `participants=${participantIds()}`
    );

    // Direct AssemblyAI STT (own API key). The session consumes room audio and
    // publishes transcription back into the room, which the salesperson client
    // receives as RoomEvent.TranscriptionReceived.
    const speechModel = resolveSpeechModel();
    log().info(
      `[lbv-agent] stt=assemblyai model=${speechModel} ` +
        `modelSource=${process.env.ASSEMBLYAI_SPEECH_MODEL?.trim() ? "env" : "pinned-default"}`
    );
    const session = new voice.AgentSession({
      vad,
      stt: new assemblyai.STT({
        apiKey: assemblyAiKey,
        speechModel: speechModel as any,
      }),
    });

    /**
     * Positive evidence that prospect audio actually reached the agent's
     * subscription (the stage that sits BEFORE AssemblyAI). Content-free: only
     * identities, track SIDs and sources are logged.
     */
    let sawProspectMicTrack = false;
    let sawFinalTranscript = false;
    ctx.room.on("trackSubscribed", (track, publication, participant) => {
      log().info(
        `[lbv-agent] track subscribed: participant=${participant.identity} ` +
          `sid=${publication.sid} source=${publication.source}`
      );
      if (participant.identity === PROSPECT_IDENTITY) {
        sawProspectMicTrack = true;
      }
    });

    /**
     * Diagnostic: which participant the SDK actually linked the session to.
     * `_roomIO` is SDK-internal, so read it defensively and only for logging.
     * The session is configured to link to `PROSPECT_IDENTITY`; if this reports
     * anything else (or "(not linked yet)"), the prospect's audio is NOT the
     * source being transcribed.
     */
    const linkedParticipantIdentity = (reason: string): string => {
      let linked = "(not linked yet)";
      try {
        const participant = (session as any)._roomIO?.linkedParticipant;
        if (participant?.identity) linked = participant.identity;
      } catch {
        /* diagnostics must never break the call */
      }
      log().info(
        `[lbv-agent] linked participant (${reason}): ${linked} (expected: ${PROSPECT_IDENTITY})`
      );
      return linked;
    };

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event: any) => {
      // Interim (partial) segments are intentionally not treated as final.
      if (!event?.isFinal) return;
      // PRIVACY: never log transcript text. It is sensitive prospect content.
      // Log only non-content diagnostics so transcription can still be
      // confirmed as received/processed.
      const charCount = typeof event.transcript === "string" ? event.transcript.length : 0;
      if (charCount > 0) sawFinalTranscript = true;
      log().info(
        `[lbv-agent] final transcript received (chars=${charCount}, ` +
          `linked=${linkedParticipantIdentity("final transcript")})`
      );
    });

    // Surface STT / session failures instead of letting them pass silently.
    session.on(voice.AgentSessionEventTypes.Error, (event: any) => {
      const err = event?.error;
      // Error text is a provider/API message: it never contains the AssemblyAI
      // key (sent as a header) nor transcript content.
      log().error(
        `[lbv-agent] session error type=${event?.type ?? "error"} label=${err?.label ?? "n/a"} ` +
          `message=${err?.message ?? String(err)}`
      );
    });

    session.on(voice.AgentSessionEventTypes.Close, (event: any) => {
      log().info(`[lbv-agent] session closed reason=${event?.reason ?? "unknown"}`);
    });

    try {
      // `session.start` attaches the session to the room and enables the built-in
      // transcription forwarding that the existing UI depends on.
      await session.start({
        room: ctx.room,
        agent: new voice.Agent({
          instructions:
            "You are a silent transcription agent for the LBV Sales Engine. Do not speak; only transcribe.",
        }),
        // CRITICAL: the SDK links the session (and its STT audio input) to ONE
        // participant. Without this it links to the FIRST participant - normally
        // the salesperson - so prospect audio is never transcribed and the
        // published transcript carries the salesperson identity, which the
        // salesperson UI's prospect-only filter discards.
        inputOptions: { participantIdentity: PROSPECT_IDENTITY },
        // This agent NEVER speaks: disabling the audio output stops the SDK from
        // publishing a silent microphone track (`roomio_audio`) that every client
        // would otherwise auto-subscribe to and negotiate an extra media section
        // for. Transcription output is a SEPARATE option and stays enabled (proven
        // by agent/tests/roomio-transcription.integration.ts).
        outputOptions: { audioEnabled: false },
      });
    } catch (error) {
      log().error(
        `[lbv-agent] session.start failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }

    linkedParticipantIdentity("session started");

    /**
     * Distinguish the two silent-failure shapes that an empty salesperson
     * transcript panel cannot: prospect audio never reached the agent's
     * subscription, vs. audio arrived but AssemblyAI produced no final segment.
     * Credential-free, content-free, and only logged once.
     */
    const transcriptWatchdog = setTimeout(() => {
      if (sawFinalTranscript) return;
      if (!sawProspectMicTrack) {
        log().warn(
          `[lbv-agent] no prospect microphone track was subscribed ${NO_TRANSCRIPT_WARN_MS}ms after the ` +
            `session started; the agent is not receiving prospect audio ` +
            `(linked=${linkedParticipantIdentity("watchdog")})`
        );
      } else {
        log().warn(
          `[lbv-agent] prospect microphone audio WAS subscribed but no final transcript was produced ` +
            `within ${NO_TRANSCRIPT_WARN_MS}ms; check the STT stage (model=${resolveSpeechModel()}) ` +
            `and any stt_error logs above`
        );
      }
    }, NO_TRANSCRIPT_WARN_MS);
    // Never keep the job alive for a diagnostic.
    transcriptWatchdog.unref?.();

    // Keep the job alive for the duration of the call.
    await new Promise<void>((resolve) => {
      ctx.room.on("disconnected", () => resolve());
    });
    clearTimeout(transcriptWatchdog);
    linkedParticipantIdentity("room disconnected");
    await session.close();
  },
});

cli.runApp(
  new WorkerOptions({
    agent: import.meta.url,
    ...(process.env.LIVEKIT_AGENT_ROOM ? { agentName: process.env.LIVEKIT_AGENT_ROOM } : {}),
  })
);
