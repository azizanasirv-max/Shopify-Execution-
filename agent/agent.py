import asyncio
import logging
import os
from dotenv import load_dotenv

from livekit import agents, rtc
from livekit.plugins import assemblyai

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("lbv-sales-agent")


async def entrypoint(ctx: agents.JobContext):
    """
    LBV Sales Engine LiveKit Agent with direct AssemblyAI STT integration.

    Subscribes to prospect audio tracks in the LiveKit room, streams audio frames
    to AssemblyAI's real-time STT API using AssemblyAI free-tier/direct credentials,
    and publishes final speech transcription events back to the room for the
    salesperson copilot UI.
    """
    logger.info(f"[LBV Agent] Connecting to LiveKit room '{ctx.room.name}'...")
    await ctx.connect(auto_subscribe=agents.AutoSubscribe.AUDIO_ONLY)

    api_key = os.getenv("ASSEMBLYAI_API_KEY")
    if not api_key:
        logger.error("[LBV Agent] ASSEMBLYAI_API_KEY is missing! Direct AssemblyAI STT requires ASSEMBLYAI_API_KEY.")
        return

    stt_provider = assemblyai.STT(api_key=api_key)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(
        track: rtc.Track,
        publication: rtc.TrackPublication,
        participant: rtc.RemoteParticipant,
    ):
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return

        # Process prospect audio tracks for transcription.
        p_id = participant.identity.lower()
        if not (p_id == "prospect" or p_id.startswith("prospect_") or p_id.startswith("prospect")):
            logger.info(f"[LBV Agent] Ignoring audio track from non-prospect participant '{participant.identity}'")
            return

        logger.info(f"[LBV Agent] Prospect joined. Starting AssemblyAI STT for participant '{participant.identity}'")
        asyncio.create_task(transcribe_prospect_track(ctx.room, participant, track, stt_provider))


async def transcribe_prospect_track(
    room: rtc.Room,
    participant: rtc.RemoteParticipant,
    track: rtc.Track,
    stt_provider: assemblyai.STT,
):
    audio_stream = rtc.AudioStream(track)
    stt_stream = stt_provider.stream()

    async def forward_audio_frames():
        async for event in audio_stream:
            stt_stream.push_frame(event.frame)

    async def process_transcripts():
        async for event in stt_stream:
            if hasattr(event, "type") and event.type == assemblyai.SpeechEventType.FINAL_TRANSCRIPT:
                text = getattr(event.transcript, "text", "").strip() if hasattr(event, "transcript") else ""
                if text:
                    logger.info(f"[LBV Agent] Final transcript from prospect ({participant.identity}): '{text}'")
                    # Emit transcription event to LiveKit room so RoomEvent.TranscriptionReceived handles it
                    segment_id = f"seg_{participant.identity}_{int(asyncio.get_event_loop().time() * 1000)}"
                    await room.local_participant.publish_transcription(
                        rtc.Transcription(
                            participant_identity=participant.identity,
                            track_sid=track.sid,
                            segments=[
                                rtc.TranscriptionSegment(
                                    id=segment_id,
                                    text=text,
                                    language="en",
                                    start_time=0,
                                    end_time=0,
                                    final=True,
                                )
                            ],
                        )
                    )

    try:
        await asyncio.gather(forward_audio_frames(), process_transcripts())
    except Exception as err:
        logger.error(f"[LBV Agent] Error in transcription stream for '{participant.identity}': {err}")
    finally:
        await stt_stream.aclose()


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
