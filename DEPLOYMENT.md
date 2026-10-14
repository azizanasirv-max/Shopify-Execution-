# LBV Sales Engine — Production Deployment Guide

Deployment target: **Cloudflare Workers** (API + static frontend) with **Cloudflare D1**
(session persistence), **Groq** as the default LLM provider, and **LiveKit Cloud** for
real-time audio/transcription.

> Status: this document describes the *verified* deployment procedure. The repository
> currently ships an intentional **D1 placeholder** and **no secrets**; `npm run check:deploy`
> fails until the database id is supplied. Nothing in this document deploys for you.

---

## 1. Architecture

- **Frontend (React 19 + Vite + Tailwind):** built by `npm run build` into `./dist` and served
  as Cloudflare Workers **Static Assets** through the `ASSETS` binding (`wrangler.toml [assets]`).
- **Worker (`worker.ts`):** pure Web-standard Request/Response entry point. Handles all `/api/*`
  routes, CORS, session auth, approval gates, and provider calls. The Worker is only invoked for
  requests that do **not** match a static asset, so static assets never shadow the API.
- **LLM:** provider-agnostic layer (`lbv-sales-copilot/engine/llm/`). **Groq is the default**;
  Gemini remains selectable via `LLM_PROVIDER=gemini`.
- **Persistence (production):** Cloudflare D1 via the `DB` binding (`CloudflareD1SessionStore`).
  The Worker **fails closed** (HTTP 500 `STARTUP_ERROR`) if `DB` is missing in production.
- **Scheduled session cleanup:** an hourly cron trigger (`[triggers] crons` in `wrangler.toml`)
  invokes the Worker's `scheduled` handler, which deletes sessions idle beyond a 24h retention window
  (and, via `ON DELETE CASCADE`, their conversation turns).
- **Persistence (local/tests):** in-memory store.

---

## 2. Prerequisites

- Node.js 20+ and npm.
- A Cloudflare account with Workers + D1 enabled.
- Wrangler v4 (`npx wrangler@4 --version`) and Cloudflare authentication:
  `npx wrangler login` (browser OAuth) or `CLOUDFLARE_API_TOKEN` with *Workers Scripts:Edit*
  and *D1:Edit* permissions. CI uses `cloudflare/wrangler-action` with an API token secret.
- A Groq API key (https://console.groq.com).
- Optional: a LiveKit Cloud project for realtime features.

---

## 3. Configuration reference

There are three distinct kinds of configuration. Do not mix them up.

### 3a. Cloudflare Worker **secrets** (sensitive — `wrangler secret put <NAME>`)

| Secret               | Required | Purpose                                             |
|----------------------|----------|-----------------------------------------------------|
| `GROQ_API_KEY`       | Yes (default provider) | Groq API key for the LLM provider       |
| `ADMIN_API_KEY`      | Recommended | Authorization for internal test endpoints        |
| `LIVEKIT_API_KEY`    | Realtime only | LiveKit API key                                 |
| `LIVEKIT_API_SECRET` | Realtime only | LiveKit API secret                              |
| `GEMINI_API_KEY`     | Only if `LLM_PROVIDER=gemini` | Gemini API key               |

### 3b. Cloudflare Worker **vars** (non-sensitive — dashboard or `wrangler.toml [vars]`)

| Var                    | Default            | Purpose                                                        |
|------------------------|--------------------|----------------------------------------------------------------|
| `NODE_ENV`             | `"production"`     | `"production"` (or absent) ⇒ fail-closed CORS; `"development"`/`"test"` ⇒ dev CORS |
| `LLM_PROVIDER`         | `groq`             | `groq` (default) or `gemini`                                   |
| `LLM_MODEL`            | provider default   | e.g. Groq `llama-3.1-8b-instant`                               |
| `LLM_TIMEOUT_MS`       | `20000`            | Per-request provider timeout                                    |
| `LBV_MAX_TOTAL_TOKENS` | `0` (disabled)     | Global cumulative token budget for the isolate                 |
| `LBV_MAX_REQUEST_TOKENS`| `0` (disabled)    | Per-request token cap                                          |
| `LIVEKIT_URL`          | —                  | `wss://your-project.livekit.cloud`                             |
| `ALLOWED_ORIGINS`      | —                  | Comma-separated approved CORS origins                          |

### 3c. Cloudflare **bindings** (in `wrangler.toml`)

| Binding  | Type          | Source                                             |
|----------|---------------|----------------------------------------------------|
| `DB`     | D1 database   | `[[d1_databases]]` — see section 5                 |
| `ASSETS` | Static assets | `[assets]` — see section 4                         |

### 3d. Local `.env` (development only)

`.env` (copied from `.env.example`) is used **only** by local tooling (`npm run dev`, `npm run test:*`).
The Worker never reads a `.env` file; in production it reads the secrets/vars/bindings above.

---

## 4. Static assets configuration

The repository uses modern **Workers Static Assets** (not the legacy Workers Sites `[site]`):

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
```

Behavior (verified with `wrangler deploy --dry-run`):
- Wrangler reads the built files from `./dist` and exposes them via `env.ASSETS`.
- The Worker script is invoked **only** for requests that do not match an asset, so `/api/*`
  always reaches `worker.ts` and cannot be shadowed by the SPA.
- `not_found_handling = "single-page-application"` serves `index.html` for client-side routes
  (e.g. `/dashboard`). `worker.ts` also has a defensive `index.html` fallback for `GET`/`HEAD`
  navigations, and returns JSON `404 NOT_FOUND` for unknown `/api/*` paths (never the SPA shell).

> The frontend is **not** considered deployed just because the Worker bundles. Confirm the asset
> upload and the served HTML during the post-deployment checks (section 11).

---

## 5. D1 setup and migration sequence

**Current configuration:** the production database `lbv-sales-sessions` exists and its real id
(`b1e94824-0128-4b48-9b88-89827a126acb`) is set in `wrangler.toml` on the `DB` binding. The guard
script still blocks deployment if a placeholder id is ever reintroduced:

```bash
npm run check:deploy   # exit 1 on a placeholder id; passes with the real id
```

**Remaining step (owner):** the schema has **not** been applied to the remote database from this
repository. Apply it once, with Cloudflare credentials (never in CI):

```bash
npx wrangler login
npx wrangler d1 migrations apply lbv-sales-sessions --remote
```

For additional environments, create a separate database and set its own explicit `database_id`;
never reuse another environment's id.

### Migration `0001_sessions_schema.sql` — expected effects

Creates two tables and four indexes:
- `sessions(id TEXT PK, auth_token TEXT NOT NULL, product_id TEXT NOT NULL, room_name TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}')` — `version` drives optimistic concurrency.
- `conversation_turns(id INTEGER PK AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id)
  ON DELETE CASCADE, turn_index INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','model')),
  text TEXT, tool_calls_json TEXT, timestamp INTEGER NOT NULL)`.
- Indexes: `idx_sessions_product`, `idx_sessions_auth_token`, `idx_sessions_last_activity`,
  `idx_turns_session_index(session_id, turn_index)`.

These columns exactly match the SQL used by `CloudflareD1SessionStore`
(`lbv-sales-copilot/engine/session-manager.ts`). Migrations are **forward-only**; take a backup
(`npx wrangler d1 export lbv-sales-sessions --remote --output backup.sql`) before future changes.

**Automated cleanup:** sessions are rejected on read once idle beyond the 1h TTL, and the hourly cron
(see §1) deletes rows idle beyond a 24h retention window so the tables do not grow without bound.
No manual cleanup is required once the Worker (with its `[triggers]` config) is deployed.

---

## 6. LLM provider (Groq default)

Groq is the initial/default provider. The Worker selects it via `LLM_PROVIDER` (default `groq`) and
reads `GROQ_API_KEY` from the secret binding. Details:

- **Default model:** `llama-3.1-8b-instant` (override with `LLM_MODEL`).
- **Auth:** sent only via the `Authorization: Bearer` header — never in the URL, never logged.
- **Errors:** HTTP 429 → rate-limit error; other non-2xx → provider error; timeouts via `LLM_TIMEOUT_MS`.
- **Fail closed:** if the selected provider's key is missing, the engine returns a `BLOCKED`
  recommendation with the safe fallback (no crash, no unapproved text).
- **Gemini remains selectable:** set `LLM_PROVIDER=gemini` and provide `GEMINI_API_KEY` (sent via the
  `x-goog-api-key` header).
- **Token budget:** `LBV_MAX_TOTAL_TOKENS` / `LBV_MAX_REQUEST_TOKENS` (0 disables). Exceeding the
  budget yields a `BLOCKED` (fail-closed) recommendation and records usage in `engineMetadata.usage`.

```bash
npx wrangler secret put GROQ_API_KEY
# Optional: npx wrangler secret put GEMINI_API_KEY   (only for LLM_PROVIDER=gemini)
```

---

## 7. CORS / allowed origins

CORS is **fail-closed** in production: when `NODE_ENV` is `"production"` *or absent in a Worker*,
unapproved or missing origins receive `Access-Control-Allow-Origin: null`. Only explicit
`ALLOWED_ORIGINS` entries are reflected. Development wildcard CORS requires an explicit
`NODE_ENV=development`.

Set `ALLOWED_ORIGINS` to your real frontend origins (comma-separated), e.g.:
```
ALLOWED_ORIGINS=https://lbv-sales-copilot.example.workers.dev,https://dashboard.example.com
```

---

## 8. Administrative authentication

The internal test/evaluation endpoints (`/api/run-adversarial-tests`, `/api/run-stage2-validation`,
`/api/save-baseline`, `/api/load-baseline`) are:
- **disabled (404 `ENDPOINT_DISABLED_IN_PRODUCTION`) in production**, including when `NODE_ENV` is absent; and
- otherwise require the `X-Admin-Token`/`Authorization` value to equal `ADMIN_API_KEY` (403 otherwise).

```bash
npx wrangler secret put ADMIN_API_KEY
```

---

## 9. LiveKit and speech-to-text (STT)

### 9a. LiveKit

Realtime token issuance and the transcript ingress require LiveKit credentials. `LIVEKIT_URL` is a
var; the key/secret are secrets:

```bash
npx wrangler secret put LIVEKIT_API_KEY
npx wrangler secret put LIVEKIT_API_SECRET
```

### 9b. STT / AssemblyAI — how transcription actually reaches the engine

There is **no direct AssemblyAI (or other STT) SDK integration in this repository**, and the Worker
does **not** read an `ASSEMBLYAI_API_KEY`. Speech-to-text runs inside the **LiveKit room**; the
browser client consumes LiveKit transcription events (`RoomEvent.TranscriptionReceived`) and forwards
final prospect segments to the Worker (`lbv-sales-copilot/app/LiveKitSalesRoom.tsx`). If AssemblyAI is
the chosen STT engine, its credentials are configured **inside LiveKit / the LiveKit agent**, not in
this Worker or its secrets.

### 9c. Transcript ingress contract (enforced by the Worker)

`POST /api/livekit/transcript` (buffered) and `POST /api/livekit/transcript/stream` (SSE):

```json
{ "sessionId": "...", "sessionToken": "...", "text": "...", "isFinal": true, "speaker": "prospect" }
```

Auth: the `x-session-token` header (or `sessionToken` in the body) must equal the session token.

| Condition | Error |
|---|---|
| Missing `sessionId` | `400 SESSION_REQUIRED` |
| Unknown session | `404 SESSION_NOT_FOUND` |
| Bad/missing token | `403 UNAUTHORIZED_SESSION_ACCESS` |
| `isFinal` not exactly `true` | `400 INVALID_FINAL_STATUS` |
| `speaker` not `prospect`/`salesperson` | `400 INVALID_SPEAKER` |
| Empty text | `400 INVALID_TRANSCRIPT` |
| Text > 4000 chars | `400 TRANSCRIPT_TOO_LONG` |

Only `speaker: "prospect"` with `isFinal: true` produces a recommendation; `salesperson` is accepted
but yields no recommendation.

### 9d. Partial/final, speaker, duplicates, ordering, reconnection

- **Partial events:** filtered client-side; the Worker rejects `isFinal !== true`.
- **Speaker:** derived client-side from the participant identity prefix (`prospect*`/`salesperson*`)
  and validated server-side.
- **Duplicates:** the client de-duplicates by provider segment id, the engine de-duplicates inside
  `handleRealtimeTranscript`, and the Worker routes add a **best-effort per-isolate** guard (10s
  window keyed by session + normalized text). Duplicates return `{ "duplicate": true,
  "recommendation": null }` (HTTP 200) and never trigger a second model call. This is
  defense-in-depth, not a durable exactly-once guarantee.
- **Ordering / stale responses:** the client keeps a monotonic request counter and an
  `AbortController`; superseded requests are cancelled and stale responses ignored.
- **Reconnection:** LiveKit reconnect is handled by the client SDK; session history is persisted in
  D1 and appended with optimistic concurrency (`addTurnsAtomicAsync`).

---

## 10. Build and deploy sequence

```bash
# 0. Install dependencies
npm install --legacy-peer-deps

# 1. TypeScript check (must be 0 errors)
npm run lint

# 2. Full deterministic test suite (offline; no real API key required)
npm test            # = tsx run-tests.ts hardening (all 10 suites)

# 3. Build the frontend
npm run build       # -> ./dist

# 4. Authenticate
npx wrangler login

# 5. Ensure D1 is configured (section 5) and the guard passes
npm run check:deploy

# 6. Dry-run (bundles the Worker and reads ./dist assets; uploads nothing)
npm run deploy:dry-run

# 7. Deploy (predeploy runs check:deploy automatically and blocks on the placeholder)
npm run deploy
```

Expected `deploy:dry-run` output includes the asset directory and bindings:
```
✨ Read N files from the assets directory .../dist
env.DB (lbv-sales-sessions)            D1 Database
env.ASSETS                             Assets
env.NODE_ENV ("production")            Environment Variable
```

---

## 11. Post-deployment health checks

```bash
# Worker is up and LiveKit config is reported (no auth required)
curl -s https://<worker-host>/api/livekit/status

# The frontend is actually served (HTML, not JSON / not 404)
curl -sI https://<worker-host>/ | head -n 1
curl -s  https://<worker-host>/ | grep -q '<div id="root">' && echo 'SPA shell OK'

# SPA deep link falls back to the app shell
curl -s https://<worker-host>/dashboard | grep -q '<div id="root">' && echo 'SPA fallback OK'

# Unknown API path returns JSON 404 (not the SPA shell)
curl -s https://<worker-host>/api/does-not-exist

# Internal endpoints are disabled in production
curl -s -o /dev/null -w '%{http_code}\n' https://<worker-host>/api/load-baseline
```

Also verify in the Cloudflare dashboard: the D1 binding `DB` points at the expected database, and
the Worker shows the `ASSETS` binding. If the SPA shell is missing, the frontend was not uploaded —
re-run `npm run build` then `npm run deploy` (do not assume success from the Worker bundle alone).

---

## 12. Rollback

- **Worker code:** `npx wrangler rollback` (reverts to the previous deployment), or redeploy a known
  good commit with `npm run deploy`.
- **Static assets:** rolled back together with the Worker version (assets are part of the deployment).
- **D1:** migrations are forward-only. Restore data with `wrangler d1 export` backups; do not run
  destructive SQL in production. Test schema changes on a non-production database first.

---

## 13. CI

**Installed:** `.github/workflows/ci.yml` runs on every push/PR to `main` — TypeScript check, the
full deterministic test suite (a **dummy** `GEMINI_API_KEY` is set only to satisfy any legacy
assumption; no real key is needed), the production build, and a Wrangler dry-run. CI never deploys
and never uses real secrets. Latest run on `main`: **success**.

A deploy workflow is intentionally not included; deployment is performed manually by the owner after
`npm run check:deploy` passes.

---

## 14. Remaining manual steps (require Cloudflare/credential access)

1. ~~Create the D1 database and set the real `database_id`~~ — **done**: `lbv-sales-sessions`
   exists and `wrangler.toml` carries its real id (section 5).
2. **Apply remote migrations** — `npx wrangler d1 migrations apply lbv-sales-sessions --remote` (section 5).
3. Create the Worker secrets: `GROQ_API_KEY`, `ADMIN_API_KEY`, and LiveKit secrets (sections 3, 6, 9).
4. Set vars: `ALLOWED_ORIGINS`, `LIVEKIT_URL`, and any `LLM_*`/token-budget overrides.
5. Run the deployment sequence (section 10) and the health checks (section 11).
6. Configure a `CLOUDFLARE_API_TOKEN` GitHub secret only if you later add a deploy workflow.

These cannot be automated from the repository without live credentials and are deliberately not
attempted here.

---

## 15. Pre-deployment checklist

### A. Before deployment (repo + credentials)

**Repository / CI**
- [x] `main` is at the intended commit.
- [x] CI workflow installed at `.github/workflows/ci.yml` and green on `main` (§13).
- [ ] Locally: `npm run lint`, `npm test`, `npm run build`, and `npm run deploy:dry-run` all pass.

**Cloudflare account**
- [ ] `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` with *Workers Scripts:Edit* + *D1:Edit*).

**D1**
- [x] Database `lbv-sales-sessions` created; real `database_id` set in `wrangler.toml`.
- [ ] `npx wrangler d1 migrations apply lbv-sales-sessions --remote` (schema not yet applied remotely).
- [ ] `npm run check:deploy` passes (no placeholder).

**Groq + admin credentials**
- [ ] `npx wrangler secret put GROQ_API_KEY`.
- [ ] `npx wrangler secret put ADMIN_API_KEY`.
- [ ] Vars: `LLM_PROVIDER=groq` (+ optional `LLM_MODEL`, `LLM_TIMEOUT_MS`, `LBV_MAX_TOTAL_TOKENS`, `LBV_MAX_REQUEST_TOKENS`).

**LiveKit + STT**
- [ ] `npx wrangler secret put LIVEKIT_API_KEY` and `... LIVEKIT_API_SECRET`.
- [ ] Var: `LIVEKIT_URL=wss://<project>.livekit.cloud`.
- [ ] Configure the transcription engine (e.g. AssemblyAI) **inside LiveKit / the LiveKit agent** — there is **no** STT key in this Worker (§9b).

**CORS + secrets hygiene**
- [ ] Var: `ALLOWED_ORIGINS` set to the deployed origin(s).
- [ ] No secrets committed to the repository.

### B. Deploy (commands in §10)

### C. After deployment (see §11 and §16)

- [ ] Health checks (§11) pass, including that the SPA shell is actually served.
- [ ] Live-audio end-to-end tests (§16) pass.

---

## 16. Live-audio end-to-end tests (require the deployed app)

These **cannot** be verified from the repository and require the deployed Worker, real credentials, and
a real microphone. They have **not** been run yet.

1. Open the deployed URL; confirm the SPA loads.
2. `GET /api/livekit/status` reports LiveKit configured.
3. Create a session (`POST /api/sessions`) and obtain a participant token (`POST /api/livekit/token`) — or use the UI.
4. Join the room as `prospect` and `salesperson` (two browsers/devices).
5. Speak as the prospect; confirm LiveKit transcription events arrive and a final segment produces a
   recommendation in the SAY THIS NEXT panel.
6. Confirm partial speech does not trigger a recommendation and that salesperson speech is ignored.
7. Confirm streaming renders incrementally and a newer utterance supersedes an older one.
8. Disconnect/reconnect; confirm session history persists (D1) and recommendations continue.
9. Confirm CORS from the real origin works and unapproved origins are rejected.
10. Confirm the internal admin endpoints return `404` in production.

> Do not mark live-audio integration as verified until steps 1–10 have been executed against the
deployed service with real credentials.

---

## 17. Sales call, prospect invitation, and transcription architecture

### 17a. Flow and endpoints

| Step | Endpoint | Auth | Notes |
|---|---|---|---|
| Salesperson creates a session | `POST /api/sessions` | none (rate-limited) | Returns `sessionId`, `sessionToken`, **`inviteToken`**, `roomName` |
| Prospect link validation | `GET /api/livekit/invite?sessionId=&token=` | invite token | Returns `{valid, productName, status}` only — no private data |
| Prospect joins | `POST /api/livekit/invite-token` | invite token | Issues a **prospect-fixed, audio-only** room token |
| Salesperson joins | `POST /api/livekit/token` | session token | Salesperson identity only |
| Transcript ingress | `POST /api/livekit/transcript[/stream]` | session token | Salesperson client forwards final prospect segments |
| End session | `DELETE /api/sessions/:id` | session token | Revokes the session and its invitation |
| Service profiles | `GET /api/service-profiles` | none | Read-only, data-only service profiles (no secrets) for the dashboard |

Invitation link format: `https://<host>/?join=1&sessionId=<id>&token=<inviteToken>`

- Renders the **prospect-only** audio page (`lbv-sales-copilot/app/ProspectCall.tsx`); the salesperson
dashboard is never rendered for a prospect (`src/App.tsx` routes on `?join=1`).
- Carries only the scoped invite token — **never** the session auth token.
- Audio only: no camera/video is requested or published; prospect tokens grant the microphone source only.
- Revoked on `DELETE /api/sessions/:id` (End Session) or when the session TTL expires.

### 17a.1 Salesperson dashboard (`src/`)

The root route renders the salesperson dashboard (`src/sales/SalesDashboard.tsx`) with a persistent
sidebar (Dashboard, New Sales Call, Live Sales Room, Call History, Service Profiles, Settings) and a
mobile drawer. The Live Sales Room embeds `lbv-sales-copilot/app/LiveKitSalesRoom.tsx`.

- Session authorization and invitation tokens are held **in memory only** (React refs) and are never
  written to `localStorage`, `sessionStorage`, or cookies. Only a non-secret default-profile preference
  is persisted locally.
- **Call History is tab-scoped.** The Worker deliberately forbids global session enumeration
  (`GLOBAL_LISTING_FORBIDDEN`), so there is no persistent cross-device history endpoint yet; the list
  reflects sessions created in the current browser tab.
- `GET /api/service-profiles` exposes the data-only `ServiceProfile` fields. Legacy adapters that do not
  expose a structured profile (the non-profile `ShopifySalesAdapter` / `GhostwriterSalesAdapter`) are
  returned with `profileAvailable: false` rather than a fabricated playbook.
- The original Google AI Studio validation console (`lbv-sales-copilot/app/page.tsx`) is no longer
  routed to and is not included in the production bundle.


### 17b. Which component produces the transcript

- **Producer:** LiveKit room transcription, delivered to the **salesperson's browser** as
`RoomEvent.TranscriptionReceived`. The salesperson client filters final prospect segments and POSTs them
to the Worker.
- **The Worker does not run speech-to-text.** It validates, de-duplicates, and feeds the segment to the
sales engine (approval gate → salesperson-only recommendation).
- **AssemblyAI:** not integrated in this repository and **no `ASSEMBLYAI_API_KEY` is read by the Worker**.
If AssemblyAI is the chosen STT engine it must be configured **inside LiveKit / a LiveKit agent**
(e.g. an agent worker using the AssemblyAI STT plugin). The browser then receives the resulting
transcription events with no change to this codebase.

### 17c. Credentials and where to configure them

| Credential | Purpose | Where |
|---|---|---|
| `GROQ_API_KEY` | Default LLM provider | Worker secret (`wrangler secret put`) |
| `ADMIN_API_KEY` | Internal test endpoints | Worker secret |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Mint room tokens (server-side) | Worker secrets |
| `LIVEKIT_URL` | LiveKit websocket URL | Worker var |
| `ALLOWED_ORIGINS` | CORS allow-list | Worker var |
| AssemblyAI key (if used) | Speech-to-text | **LiveKit / agent configuration** — not the Worker |
| Cloudflare API token | CI deploy (optional) | GitHub secret |

### 17d. Abuse protection

- Session creation is bounded by a **durable, D1-backed** limit (60 creations/minute across isolates),
returning `429 RATE_LIMITED`. It is a coarse global guard, not a substitute for platform protection.
- For production traffic shaping, add a **Cloudflare Rate Limiting rule** on `/api/sessions` and
`/api/livekit/invite-token`. Do not rely on an isolate-local counter.

### 17e. Testing the call and transcription workflow

**Automated (CI, offline)** — session creation + invite token issuance, invitation validation
(valid/wrong/expired/unknown), prospect-only identity enforcement, transcript validation and
deduplication, approval gates, salesperson-only visibility, session cleanup, request-size validation
(including bodies without `Content-Length`), and the session-creation limit.

**Requires a real microphone and a deployed environment** — two-party audio, real LiveKit tokens,
real STT (LiveKit/AssemblyAI), reconnection behaviour, and end-to-end recommendation latency.

Manual live-call test:
1. Deploy (section 10) and confirm the health checks (section 11).
2. Open the dashboard (**New Sales Call**), select a service profile, and create the session, then tap
   **Copy** / **Share** to distribute the prospect invitation link.
3. Open that link on a phone; confirm it shows the prospect audio page (no salesperson content).
4. Tap **Join Call**, allow the microphone, and speak as the prospect.
5. Confirm the salesperson dashboard shows the prospect as connected in the Live Sales Room, the prospect
   transcript, and an approved **Say this next** recommendation; confirm the prospect page shows no
   recommendations.
6. Toggle mute, leave, rejoin, and finally tap **End Session**; confirm the invitation link is revoked.

---

## 18. LiveKit Agent + direct AssemblyAI STT

### 18a. Why a separate component is required

The Worker cannot run speech-to-text (stateless request/response, no persistent media
connection). The repository now includes the missing component at **`agent/`**: a long-running
LiveKit Agent that joins the room, streams audio to the **direct AssemblyAI API** (your own
AssemblyAI key / free tier — *not* LiveKit Inference), and publishes transcription into the room.

Data path:
```
prospect mic → LiveKit room → agent (agent/) → AssemblyAI streaming STT
                                    └→ publishes transcription into the room
salesperson browser (RoomEvent.TranscriptionReceived)
   → POST /api/livekit/transcript[/stream] → approval gate → SAY THIS NEXT
```
The salesperson UI and the Worker already consume `RoomEvent.TranscriptionReceived` and forward
**final prospect** segments; **no frontend or Worker change is required** for the agent to be useful.

> Status: the agent code typechecks against `@livekit/agents@1.9.2` (+ AssemblyAI and Silero plugins),
> but **no real call has been made**. Speech-to-text is **not verified** until a live call is run.

### 18b. Agent hosting

The agent is a persistent Node.js process, so it does **not** run on Cloudflare Workers. Options:

| Option | Notes |
|---|---|
| LiveKit Cloud agent deploy (`lk agent deploy` / `livekit/deploy-action`) | Managed; simplest if you use LiveKit Cloud — **prepared in this repo** (§18b-1) |
| Fly.io / Railway / Render | Long-running container; `npm start` in `agent/` |
| A VPS / Docker host | Full control |

Requirements: Node.js 20+, outbound network to LiveKit and `api.assemblyai.com`, and the agent env
vars below. Run `cd agent && npm install && npm run typecheck && npm run dev` locally first.

### 18b-1. LiveKit Cloud deployment artifacts (prepared, not deployed)

The `agent/` directory is now a complete LiveKit Cloud deployment unit:

| File | Role |
|---|---|
| `agent/Dockerfile` | glibc (Debian slim) base, `ca-certificates` (required by the LiveKit SDK), non-root `appuser`, `WORKDIR /app`, `npm ci --omit=dev`, `livekit-agents download-files`, `CMD ["node", "--import", "tsx", "agent.ts", "start"]` |
| `agent/.dockerignore` | excludes `node_modules` and all `.env*` from the build context |
| `agent/livekit.toml.example` | template for the deployment config (real file is generated on first registration) |
| `.github/workflows/deploy-agent.yml` | `livekit/deploy-action@v2` with `WORKING_DIRECTORY: agent` — currently **staged** at `agent/deploy/deploy-agent.yml`, see below |

**Workflow file is staged, not installed:** GitHub rejected pushing
`.github/workflows/deploy-agent.yml` because the automation account used for this
branch is a GitHub App installation **without the `workflows` permission**
(`refusing to allow a GitHub App to create or update workflow ... without
workflows permission`). The workflow and an optional `agent/` typecheck CI job are
therefore committed to `agent/deploy/` together with install instructions
(`agent/deploy/README.md`). Copy `agent/deploy/deploy-agent.yml` to
`.github/workflows/deploy-agent.yml` (web UI or `git mv`) to activate deployment.

**Why `livekit.toml` is a template, not the real file:** LiveKit Cloud assigns the agent ID when the
agent is first registered, so `[agent] id` cannot be fabricated. Register with the workflow
(`workflow_dispatch`, operation `create`) or `lk agent create`; both write `agent/livekit.toml` and
deploy. The `deploy` operation fails with `livekit.toml not found` until it exists.

**Credential handling:** the four GitHub secrets (`LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `ASSEMBLYAI_API_KEY`) are used only at deploy time. The deployed agent receives
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` automatically from LiveKit Cloud — they
cannot be set as agent secrets and are never written into the image. `ASSEMBLYAI_API_KEY` is passed
through `SECRET_LIST`, stored by LiveKit Cloud secrets management, and injected into the container at
runtime as a plain environment variable. The workflow fails fast if a secret is missing and asserts
that the Dockerfile defines no credential variables.

**Free (Build) plan:** production agents scale to zero when idle, so the first caller after an idle
period waits 10–20 s for the cold start. Instant rollback is paid-plan only — revert and redeploy.

**Dispatch:** `LIVEKIT_AGENT_ROOM` is left unset, so the worker registers with an empty agent name and
uses **automatic dispatch** — it joins every new room in the project. Rooms are created per session by
the Worker, so the agent joins the sales room and publishes `RoomEvent.TranscriptionReceived`
segments carrying the speaker's participant identity; the salesperson UI keeps working unchanged.

**Verification status:** the agent typechecks and the container entrypoint was executed locally (it
starts and fails only on the missing LiveKit credentials that LiveKit Cloud injects). **No real audio
has been transcribed end-to-end**; that requires a deployed agent, a live two-party room, and a valid
AssemblyAI key (§20 step 8).

### 18c. Call termination semantics (important)

`DELETE /api/sessions/:id` now:
1. deletes the D1 session (revokes the **invitation** — no new token can be minted), and
2. calls `RoomServiceClient.deleteRoom(roomName)` when LiveKit is configured.

The response reports `invitationRevoked: true` and `liveKitRoomClosed: <bool>` so the caller can tell
whether the room teardown actually succeeded. **Deleting a D1 record does not by itself invalidate an
already-issued LiveKit JWT** — deleting the *room* is what stops participation and prevents rejoining.
Keep LiveKit token TTLs short as defence in depth.

### 18d. Abuse protection

- `/api/sessions` **and** the unauthenticated `/api/copilot` session-creation fallback now share the
  same **durable, D1-backed** limit (60 creations/minute across isolates → `429 RATE_LIMITED`).
- This is a coarse application-level guard. It is **not** equivalent to platform protection. Add
  **Cloudflare Rate Limiting** rules for `/api/sessions`, `/api/livekit/invite-token` and
  `/api/copilot` in production.

### 18e. Invitation-token hygiene

- Responses set `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- `index.html` declares `<meta name="referrer" content="no-referrer">`.
- The prospect page removes the token from the address bar (`history.replaceState`) once validated.
- Residual exposure: the token is present in the invitation URL the salesperson shares; treat the link
  as a secret and revoke by ending the session.

---

## 19. Credential checklist (exact)

### A. Cloudflare Worker (secrets via `wrangler secret put`, vars in `[vars]`)

| Name | Status | Purpose | Where | Consumer | How to obtain |
|---|---|---|---|---|---|
| `DB` (binding) | **Required** | D1 session persistence | `wrangler.toml` | Worker | `wrangler d1 create lbv-sales-sessions` |
| `ASSETS` (binding) | **Required** | Serve the SPA | `wrangler.toml [assets]` | Worker | Build (`npm run build`) |
| `NODE_ENV` | **Required** (var) | `production` fail-closed CORS | `[vars]` | Worker | Literal `production` |
| `GROQ_API_KEY` | **Required** (default provider) | LLM recommendations | Worker secret | Worker | console.groq.com |
| `LIVEKIT_URL` | **Required for calls** (var) | LiveKit websocket + room API host | Worker var | Worker | LiveKit Cloud project settings |
| `LIVEKIT_API_KEY` | **Required for calls** | Mint room tokens, delete rooms | Worker secret | Worker | LiveKit Cloud API keys |
| `LIVEKIT_API_SECRET` | **Required for calls** | Same as above | Worker secret | Worker | LiveKit Cloud API keys |
| `ADMIN_API_KEY` | **Optional** | Internal test endpoints (404 in prod anyway) | Worker secret | Worker | Generate a random string |
| `ALLOWED_ORIGINS` | **Conditional** | Cross-origin browser access | Worker var | Worker | Your deployed origin(s) |
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_TIMEOUT_MS` | Optional | Provider overrides | Worker var | Worker | Defaults `groq` / `llama-3.1-8b-instant` / 20000 |
| `LBV_MAX_TOTAL_TOKENS` / `LBV_MAX_REQUEST_TOKENS` | Optional | Token budget (0 = off) | Worker var | Worker | Your policy |
| `GEMINI_API_KEY` | Conditional | Only if `LLM_PROVIDER=gemini` | Worker secret | Worker | Google AI Studio |
| `LBV_SESSION_STORE` | Optional | Force D1 store outside prod | Worker var | Worker | `cloudflare-d1` |

`ALLOWED_ORIGINS` is only needed when the browser calls the Worker from a **different origin** than the
Worker itself. When the SPA is served by the same Worker (`[assets]`), same-origin requests are not
subject to CORS. Set it explicitly for custom domains/Pages frontends.

### B. LiveKit Cloud

| Setting | Status | Purpose | Where |
|---|---|---|---|
| Project URL (`wss://…livekit.cloud`) | Required | Room transport | LiveKit Cloud → Project settings |
| API key + secret | Required | Worker token minting + room deletion; agent auth | LiveKit Cloud → API keys |
| Agent dispatch (automatic or room-name) | Required | Makes the agent join rooms | LiveKit Cloud agent settings / agent `agentName` |
| Room/agent permissions | Default | Audio publish/subscribe | LiveKit Cloud |

No LiveKit webhook is required by the current code.

### C. AssemblyAI

| Setting | Status | Purpose | Where |
|---|---|---|---|
| `ASSEMBLYAI_API_KEY` | **Required for STT** | Direct streaming STT (your own account/free tier) | **Agent runtime env only** — never the Worker or browser |
| `ASSEMBLYAI_SPEECH_MODEL` | Optional | Speech model override | Agent runtime env |
| Account/region + usage limits | Required | Free-tier concurrency/limits | assemblyai.com dashboard |

Obtain the key at <https://www.assemblyai.com/dashboard>. The Worker does **not** read any AssemblyAI
variable.

### D. Agent hosting

| Name | Status | Purpose | Where |
|---|---|---|---|
| `LIVEKIT_URL` | Required | Agent connects to the room | Agent env |
| `LIVEKIT_API_KEY` | Required | Agent authentication | Agent env |
| `LIVEKIT_API_SECRET` | Required | Agent authentication | Agent env |
| `ASSEMBLYAI_API_KEY` | Required | Direct STT | Agent env |
| `LIVEKIT_AGENT_ROOM` | Optional | Pin the agent to one room | Agent env |
| Node.js 20+ host | Required | Persistent process | Fly.io / Railway / Render / VPS / `lk agent deploy` |

### E. GitHub Actions secrets (LiveKit Cloud deploy only)

Set in **Settings → Secrets and variables → Actions**. None of these are ever committed; the deployed
agent gets its LiveKit credentials from LiveKit Cloud and `ASSEMBLYAI_API_KEY` from LiveKit Cloud
secrets management.

| Secret | Status | Purpose |
|---|---|---|
| `LIVEKIT_URL` | Required | Deploy-time authentication (`livekit/deploy-action`) |
| `LIVEKIT_API_KEY` | Required | Deploy-time authentication |
| `LIVEKIT_API_SECRET` | Required | Deploy-time authentication |
| `ASSEMBLYAI_API_KEY` | Required | Passed via `SECRET_LIST` → runtime env var `ASSEMBLYAI_API_KEY` in the agent container |

Do **not** create `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` as agent secrets — LiveKit
Cloud injects them automatically and rejects them as secrets.

---

## 20. Shortest safe sequence

1. **Install the agent**: `cd agent && npm install && npm run typecheck`.
2. **Worker secrets**: `GROQ_API_KEY`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (+ `ADMIN_API_KEY`).
3. **Worker vars**: `LIVEKIT_URL`, and `ALLOWED_ORIGINS` if using a custom domain.
4. **D1**: `wrangler d1 migrations apply lbv-sales-sessions --remote`.
5. **Agent env**: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ASSEMBLYAI_API_KEY`
   (local/Fly/Railway) — for LiveKit Cloud these are GitHub secrets instead, see §19 E.
6. **Register + deploy the agent to LiveKit Cloud** (free Build plan): add the four GitHub secrets
   (§19 E), then run **Actions → Deploy LiveKit Agent → Run workflow → operation: `create`**. This
   registers the agent, deploys it, and opens a PR adding `agent/livekit.toml` — **merge that PR**
   (it contains no credentials). Later pushes to `main` touching `agent/**` deploy automatically.
   Alternatively run `lk cloud auth && lk agent create` in `agent/`.
7. **Deploy the Worker**: `npm run check:deploy && npm run deploy`.
8. **Live test**: create a session → copy the invitation link → join on a phone → speak → confirm the
   prospect transcript and an approved SAY THIS NEXT recommendation appear for the salesperson, and
   that the prospect page shows no recommendations.
9. **End Session** and confirm the invitation no longer validates (`404`) and `liveKitRoomClosed: true`.
10. **Cloudflare Rate Limiting** rules for `/api/sessions`, `/api/livekit/invite-token`, `/api/copilot`.
11. Review and merge PR #9, then re-run CI on `main`.
12. **Confirm the deployed agent** joined the room: `lk agent status` / `lk agent logs` should show
    `[lbv-agent] connected to room <name>` and `final transcript received (speaker=..., chars=...)`.
    Until that is observed, speech-to-text must be treated as unverified.
