# LBV LiveKit Agent — direct AssemblyAI speech-to-text

This is the **missing component** that turns room audio into transcripts. The
Cloudflare Worker cannot run STT; this long-running agent does it and publishes
transcription events into the LiveKit room, which the existing salesperson UI
already consumes.

## Why a separate process

- The Worker is request/response and stateless per isolate — it cannot hold a
  WebRTC/WebSocket audio stream.
- LiveKit Agents run as a persistent worker process (Node.js) that LiveKit
  dispatches into rooms.
- Using the **direct AssemblyAI plugin** means AssemblyAI is billed against
  **your own AssemblyAI account / free tier**, not LiveKit Inference.

## Data flow

```
prospect mic ─▶ LiveKit room ─▶ agent (this process) ─▶ AssemblyAI streaming STT
                                        │
                                        └─▶ publishes transcription into the room
                                                   │
                       salesperson browser ◀───────┘  (RoomEvent.TranscriptionReceived)
                                        │
                                        └─▶ POST /api/livekit/transcript[/stream]
                                                   │
                                            approval gate ▶ SAY THIS NEXT
```

## Requirements

| Item | Where |
|---|---|
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | agent runtime env |
| `ASSEMBLYAI_API_KEY` | agent runtime env (AssemblyAI dashboard) |
| Node.js 20+ | agent host |
| A long-running host | Fly.io, Railway, Render, a VPS, or `lk agent deploy` (LiveKit Cloud) |

## Run locally

```bash
cd agent
cp .env.example .env.local     # fill in values (never commit)
npm install
npm run dev
```

## Verify the type-level API against the installed SDK

```bash
cd agent && npm run typecheck
```

> The agent code targets the LiveKit Agents JS SDK (`@livekit/agents`) with the
> AssemblyAI plugin. If your installed SDK version differs, the import names may
> need a small adjustment; run `npm run typecheck` after install to confirm.
