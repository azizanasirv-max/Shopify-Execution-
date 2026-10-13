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

## Deploy to LiveKit Cloud

This directory is a complete deployment unit for LiveKit Cloud
([agent deployment docs](https://docs.livekit.io/deploy/agents/)):

| File | Purpose |
|---|---|
| `Dockerfile` | glibc base image, non-root user, `ca-certificates`, fixed `CMD` |
| `.dockerignore` | keeps the build context small and excludes `.env*` / `node_modules` |
| `package.json` | `start` script = `node --import tsx agent.ts start` |
| `livekit.toml.example` | template for the agent config generated on first registration |

### 1. Register the agent (one time)

LiveKit Cloud issues the agent ID on first registration; it cannot be guessed.
Either run the GitHub Actions workflow `.github/workflows/deploy-agent.yml`
(**Actions → Deploy LiveKit Agent → Run workflow → operation: `create`**), which
registers the agent, deploys it, and opens a PR containing the generated
`agent/livekit.toml`; or use the CLI from this directory:

```bash
lk cloud auth
lk agent create          # creates Dockerfile/livekit.toml if missing
```

Commit the generated `livekit.toml` (it holds only the project subdomain and the
agent ID — no credentials). Afterwards, pushes to `main` that touch `agent/**`
deploy automatically.

### 2. Required GitHub Actions secrets

| Secret | Used for |
|---|---|
| `LIVEKIT_URL` | deploy-time authentication only |
| `LIVEKIT_API_KEY` | deploy-time authentication only |
| `LIVEKIT_API_SECRET` | deploy-time authentication only |
| `ASSEMBLYAI_API_KEY` | passed via `SECRET_LIST` → stored as a LiveKit Cloud agent secret and injected at **runtime** |

Never commit these. The agent image contains no credentials: LiveKit Cloud
injects `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` automatically
(they cannot be set as agent secrets), and `ASSEMBLYAI_API_KEY` comes from
LiveKit Cloud secrets management.

### 3. Room dispatch behaviour

The worker is started with **no agent name** (`LIVEKIT_AGENT_ROOM` unset), which
means LiveKit's **automatic dispatch**: the agent joins every new room in the
project. The sales room is created per session by the Worker
(`POST /api/livekit/token` / `invite-token`), so the agent joins it and forwards
`RoomEvent.TranscriptionReceived` segments — with the speaker's participant
identity (`prospect` / `salesperson`) — to every participant. The salesperson UI
(`lbv-sales-copilot/app/LiveKitSalesRoom.tsx`) consumes final `prospect`
segments and posts them to the Worker.

To pin the agent to explicit dispatch instead, set `LIVEKIT_AGENT_ROOM` as an
agent secret (it becomes `agentName`) and dispatch it per room.

### 4. Free (Build) plan behaviour

On the Build plan, idle agents scale to zero replicas, so the first caller after
an idle period waits **10–20 s** for the cold start before the agent joins the
room. Deployment uses a rolling strategy; instant rollback requires a paid plan
(revert the code and redeploy instead).

### 5. Verification status

`npm run typecheck` and the container entrypoint are verified locally (the
worker starts and fails only on missing LiveKit credentials, which LiveKit Cloud
injects). **Real audio transcription has not been exercised end-to-end** — that
requires a deployed agent, a live room, and a valid AssemblyAI key. See
`DEPLOYMENT.md` §18 for the live verification steps.

