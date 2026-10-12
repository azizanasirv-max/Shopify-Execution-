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

`wrangler.toml` ships an **intentional placeholder** `database_id`. The build will not stop you,
so the guard script does:

```bash
npm run check:deploy   # FAILS (exit 1) while the placeholder is present
```

Safe sequence (run by the project owner, with Cloudflare credentials — never automated in CI):

```bash
# 1. Authenticate
npx wrangler login

# 2. Create the database (records its real database_id). DO NOT do this in CI.
npx wrangler d1 create lbv-sales-sessions

# 3. Put the REAL database_id into wrangler.toml (replace the 00000000-... placeholder).
#    Keep it explicit per environment; do not reuse another environment's id.

# 4. Apply the schema migrations to the remote database.
npx wrangler d1 migrations apply lbv-sales-sessions --remote

# 5. Confirm the guard now passes
npm run check:deploy
```

Schema (preserved as-is): `migrations/0001_sessions_schema.sql` creates `sessions` and
`conversation_turns` (with `ON DELETE CASCADE` and lookup indexes). Session/turn semantics are
unchanged. Migrations are **forward-only**; take a D1 backup (`wrangler d1 export`) before future
schema changes.

> Do not invent or hardcode a database id. For multiple environments, use Wrangler environments
> (`[env.staging]`, `[env.production]`) each with its own explicit `database_id`.

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

## 9. LiveKit configuration

Realtime token issuance and the transcript ingress require LiveKit credentials. Set `LIVEKIT_URL`
as a var and the key/secret as secrets:

```bash
npx wrangler secret put LIVEKIT_API_KEY
npx wrangler secret put LIVEKIT_API_SECRET
```

The LiveKit server URL is non-sensitive and can live in `[vars]` or the dashboard. LiveKit +
AssemblyAI end-to-end integration is a separate, mandatory post-deployment phase.

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

The CI workflow is committed at **`ci/github-actions-ci.yml`**. It runs on every push/PR to `main`:
TypeScript check, the full deterministic test suite (a **dummy** Gemini value is set only to satisfy
any legacy assumption; no real key is needed), the production build, and a Wrangler dry-run. CI never
deploys and never uses real secrets.

**One-time install (required):** the automation used to prepare this change cannot create files under
`.github/workflows/` (the GitHub App token lacks the `workflows` permission). A repository owner must
move the file into place once:

```bash
mkdir -p .github/workflows
git mv ci/github-actions-ci.yml .github/workflows/ci.yml
git commit -m "ci: enable GitHub Actions workflow"
git push
```

Or use the GitHub UI: create `.github/workflows/ci.yml` and paste the contents of
`ci/github-actions-ci.yml`. After that, CI runs automatically on pushes and PRs to `main`.

A deploy workflow is intentionally not included; deployment is performed manually by the owner after
`npm run check:deploy` passes.

---

## 14. Remaining manual steps (require Cloudflare/credential access)

1. Create the D1 database and set the real `database_id` (section 5).
2. Apply remote migrations (section 5).
3. Create the Worker secrets: `GROQ_API_KEY`, `ADMIN_API_KEY`, and LiveKit secrets (sections 3, 6, 9).
4. Set vars: `ALLOWED_ORIGINS`, `LIVEKIT_URL`, and any `LLM_*`/token-budget overrides.
5. Run the deployment sequence (section 10) and the health checks (section 11).
6. Configure a `CLOUDFLARE_API_TOKEN` GitHub secret only if you later add a deploy workflow.

These cannot be automated from the repository without live credentials and are deliberately not
attempted here.
