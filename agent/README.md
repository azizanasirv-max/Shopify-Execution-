# LiveKit Agent with Direct AssemblyAI Speech-to-Text

This agent acts as a silent speech-to-text listener for the LBV Sales Engine. It joins LiveKit rooms, subscribes to prospect audio streams, transcribes speech in real time using AssemblyAI's direct WebSocket API, and broadcasts final transcripts back to the room as well as forwarding them directly to the Cloudflare Worker.

## Required Environment Variables

```env
LIVEKIT_URL=wss://your-livekit-instance.livekit.cloud
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
ASSEMBLYAI_API_KEY=your_assemblyai_api_key
WORKER_BASE_URL=https://your-worker.workers.dev
```

## Running Locally

```bash
pip install -r requirements.txt
python agent.py dev
```

## Production Deployment Options

### 1. Fly.io / Modal / Railway Container Deployment
Build and run using the provided `Dockerfile`. Set the environment variables in your deployment dashboard.

### 2. LiveKit CLI Agent Hosting
Deploy as a background worker process connected to your LiveKit Cloud instance.
