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
