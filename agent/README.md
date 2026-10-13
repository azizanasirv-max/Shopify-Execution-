# LBV Sales Engine — LiveKit AssemblyAI STT Agent

This directory contains the lightweight Python LiveKit Agent responsible for converting prospect speech to text using AssemblyAI's direct API integration.

## Architecture & Workflow

```
[Prospect Microphone]
       │
       ▼
  LiveKit Room (WebRTC Audio Track)
       │
       ▼
 [LBV LiveKit Agent (agent/agent.py)]
       │ (audio stream)
       ▼
 [AssemblyAI Realtime STT API]
       │ (final transcript)
       ▼
 [LiveKit Room Transcription Event (RoomEvent.TranscriptionReceived)]
       │
       ▼
 [Salesperson Browser Interface (LiveKitSalesRoom.tsx)]
       │
       ▼
 [Cloudflare Worker API (/api/livekit/transcript/stream)]
       │
       ▼
 [Generic Sales Engine -> SAY THIS NEXT Guidance]
```

## Environment Credentials

The LiveKit Agent requires the following environment variables:

| Variable | Description |
|---|---|
| `LIVEKIT_URL` | WebSocket URL of your LiveKit Cloud project (`wss://<project>.livekit.cloud`) |
| `LIVEKIT_API_KEY` | LiveKit API Key |
| `LIVEKIT_API_SECRET` | LiveKit API Secret |
| `ASSEMBLYAI_API_KEY` | AssemblyAI API Key (direct API / free-tier allowance) |

## Local Development & Setup

1. **Install Python dependencies:**
   ```bash
   cd agent
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Configure environment:**
   Create a `.env` file in the `agent/` directory:
   ```env
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=your_livekit_api_key
   LIVEKIT_API_SECRET=your_livekit_api_secret
   ASSEMBLYAI_API_KEY=your_assemblyai_api_key
   ```

3. **Run the agent in dev mode:**
   ```bash
   python agent.py dev
   ```

## Practical Hosting & Deployment Options

Since the LiveKit Agent process needs persistent network connectivity (WebSockets) to LiveKit Cloud and AssemblyAI, it runs as a background service/worker:

1. **LiveKit Cloud Agent Hosting (Recommended for Production)**:
   - Deploy directly using LiveKit CLI:
     ```bash
     lk agent deploy --directory ./agent
     ```
   - Managed directly by LiveKit Cloud with automatic scaling and zero infrastructure management.

2. **Serverless Container / Micro-host (Fly.io or Railway)**:
   - Dockerfile:
     ```dockerfile
     FROM python:3.11-slim
     WORKDIR /app
     COPY requirements.txt .
     RUN pip install --no-cache-dir -r requirements.txt
     COPY agent.py .
     CMD ["python", "agent.py", "start"]
     ```
   - Deploy to Fly.io (`fly launch`) or Railway with environment variables configured.

3. **VPS / Cloud Instance (EC2 / DigitalOcean)**:
   - Run via `systemd` or `docker-compose` as a continuous background daemon.
