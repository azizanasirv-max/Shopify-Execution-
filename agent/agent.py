import asyncio
import logging
import os
import aiohttp
from dotenv import load_dotenv

from livekit import agents, rtc
from livekit.agents import JobContext, JobRequest, WorkerOptions, cli, stt
from livekit.plugins import assemblyai

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("lbv-livekit-assemblyai-agent")

# Configuration from environment
WORKER_BASE_URL = os.getenv("WORKER_BASE_URL", "http://localhost:8787")
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY")
AGENT_SECRET_KEY = os.getenv("AGENT_SECRET_KEY", "")

async def function_entrypoint(ctx: JobContext):
    logger.info(f"Connecting agent to room: {ctx.room.name}")
    await ctx.connect()

    # Extract sessionId from roomName if formatted as room_{productId}_{sessionId}
    session_id = None
    room_parts = ctx.room.name.split("_")
    if len(room_parts) >= 3:
        session_id = "_".join(room_parts[2:])

    logger.info(f"Inferred session ID for transcript forwarder: {session_id}")

    # Initialize direct AssemblyAI STT plugin
    stt_provider = assemblyai.STT(api_key=ASSEMBLYAI_API_KEY)

    @ctx.room.on("participant_connected")
    def on_participant_connected(participant: rtc.RemoteParticipant):
        logger.info(f"Participant connected: {participant.identity}")

    @ctx.room.on("track_published")
    def on_track_published(publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        if publication.kind == rtc.TrackKind.KIND_AUDIO:
            logger.info(f"Audio track published by participant: {participant.identity}")
            publication.set_subscribed(True)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            logger.info(f"Subscribed to audio track from {participant.identity}. Starting AssemblyAI transcription stream...")
            asyncio.create_task(process_audio_stream(track, participant, stt_provider, ctx, session_id))

async def process_audio_stream(
    track: rtc.AudioTrack,
    participant: rtc.RemoteParticipant,
    stt_provider: stt.STT,
    ctx: JobContext,
    session_id: str
):
    audio_stream = rtc.AudioStream(track)
    stt_stream = stt_provider.stream()

    async def send_audio_frames():
        async for frame in audio_stream:
            stt_stream.push_frame(frame)
        stt_stream.end_input()

    async def receive_transcripts():
        async for event in stt_stream:
            if event.type == stt.SpeechEventType.FINAL_TRANSCRIPT:
                text = event.alternative.text.strip()
                if not text:
                    continue

                logger.info(f"Final Transcript [{participant.identity}]: {text}")

                # Publish transcript event to the LiveKit room so connected clients receive RoomEvent.TranscriptionReceived
                try:
                    await ctx.room.local_participant.publish_transcription(
                        rtc.Transcription(
                            participant_identity=participant.identity,
                            track_sid=track.sid,
                            segments=[
                                rtc.TranscriptionSegment(
                                    id=f"seg_{participant.identity}_{int(asyncio.get_event_loop().time()*1000)}",
                                    text=text,
                                    start_time=0,
                                    end_time=0,
                                    language="en",
                                    final=True
                                )
                            ]
                        )
                    )
                except Exception as e:
                    logger.warning(f"Failed to publish room transcription event: {e}")

                # Direct REST fallback to Cloudflare Worker transcript ingress endpoint if session_id is present
                if session_id:
                    asyncio.create_task(forward_transcript_to_worker(session_id, participant.identity, text))

    await asyncio.gather(send_audio_frames(), receive_transcripts())

async def forward_transcript_to_worker(session_id: str, identity: str, text: str):
    speaker = "prospect" if "prospect" in identity.lower() else "salesperson"
    url = f"{WORKER_BASE_URL.rstrip('/')}/api/livekit/transcript"

    headers = {
        "Content-Type": "application/json"
    }
    if AGENT_SECRET_KEY:
        headers["x-session-token"] = AGENT_SECRET_KEY

    # Internal agent forwarding payload
    payload = {
        "sessionId": session_id,
        "sessionToken": AGENT_SECRET_KEY,
        "text": text,
        "isFinal": True,
        "speaker": speaker
    }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers, timeout=5) as resp:
                if resp.status == 200:
                    logger.info(f"Forwarded transcript for session {session_id} to Worker successfully.")
                else:
                    logger.warning(f"Worker rejected transcript forwarding: HTTP {resp.status}")
    except Exception as e:
        logger.error(f"Error forwarding transcript to Worker: {e}")

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=function_entrypoint))
