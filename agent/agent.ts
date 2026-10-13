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
 * segments, and POSTs them to the Worker's transcript endpoint. No frontend or
 * Worker change is required for this agent to be useful.
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[lbv-agent] Missing required environment variable: ${name}`);
  }
  return value;
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    // Load the VAD once per process; it is reused across jobs.
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    const assemblyAiKey = requireEnv("ASSEMBLYAI_API_KEY");
    const vad = (ctx.proc.userData.vad as silero.VAD) ?? (await silero.VAD.load());

    await ctx.connect();
    log().info(`[lbv-agent] connected to room ${ctx.room.name}`);

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

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event: any) => {
      if (event?.isFinal) {
        log().info(`[lbv-agent] final transcript (${event.speakerId ?? "speaker"}): ${event.transcript}`);
      }
    });

    // `session.start` attaches the session to the room and enables the built-in
    // transcription forwarding that the existing UI depends on.
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({
        instructions:
          "You are a silent transcription agent for the LBV Sales Engine. Do not speak; only transcribe.",
      }),
    });

    // Keep the job alive for the duration of the call.
    await new Promise<void>((resolve) => {
      ctx.room.on("disconnected", () => resolve());
    });
    await session.close();
  },
});

cli.runApp(
  new WorkerOptions({
    agent: import.meta.url,
    ...(process.env.LIVEKIT_AGENT_ROOM ? { agentName: process.env.LIVEKIT_AGENT_ROOM } : {}),
  })
);
