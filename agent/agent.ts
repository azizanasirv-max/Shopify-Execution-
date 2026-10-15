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
    const session = new voice.AgentSession({
      vad,
      stt: new assemblyai.STT({
        apiKey: assemblyAiKey,
        ...(process.env.ASSEMBLYAI_SPEECH_MODEL
          ? { speechModel: process.env.ASSEMBLYAI_SPEECH_MODEL as any }
          : {}),
      }),
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
      });
    } catch (error) {
      log().error(
        `[lbv-agent] session.start failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }

    linkedParticipantIdentity("session started");

    // Keep the job alive for the duration of the call.
    await new Promise<void>((resolve) => {
      ctx.room.on("disconnected", () => resolve());
    });
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
