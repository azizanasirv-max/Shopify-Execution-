# LBV Sales Engine — Production Deployment Guide

This document covers deployment of the LBV Sales Engine on **Cloudflare Workers** (backend API + static assets) and **Cloudflare D1** (session persistence), using **LiveKit Cloud** for real-time audio transport and transcription.

## 1. Architecture Overview

- **Frontend (React 19 + Vite + Tailwind CSS):** Served as static assets from the Cloudflare Worker via the `[site]` bucket (`dist/`). Built via `npm run build`. Connects to LiveKit Cloud and receives real-time "SAY THIS NEXT" recommendations via Worker API calls triggered by LiveKit transcription events.

- **Backend Sales Engine (Cloudflare Worker / TypeScript):** Entry point: `worker.ts` (pure Web-standard Request/Response, zero Node.js runtime dependencies). Implements deterministic approval gates, product adapters (Shopify, Ghostwriter), session authorization, CORS, and sanitized error responses.

- **LLM Provider:** Gemini via `GeminiWorkerModelProvider` (implements the `ModelProvider` interface in `lbv-sales-copilot/engine/types.ts`). Switching providers requires implementing `ModelProvider` and updating worker initialization — no engine changes needed.

- **Session Persistence (Production):** Cloudflare D1 (`CloudflareD1SessionStore`). The `DB` binding must be set in `wrangler.toml`. The worker **fails closed** (500) if `DB` is absent in production — no in-memory fallback.

- **Session Persistence (Dev/Test):** In-memory store (`InMemorySessionStore`).

## 2. Required Configuration Before Deploying

### Secrets (set via `wrangler secret put <NAME>` — never commit to source)

| Secret             | Description                                     |
|--------------------|-------------------------------------------------|
| `GEMINI_API_KEY`   | Gemini API key for the LLM provider             |
| `LIVEKIT_API_KEY`  | LiveKit API key                                 |
| `LIVEKIT_API_SECRET` | LiveKit API secret                            |
| `ADMIN_API_KEY`    | Admin API key for protected internal endpoints  |

### Vars (set in Cloudflare dashboard or `wrangler.toml [vars]`)

| Variable         | Description                                              |
|------------------|----------------------------------------------------------|
| `NODE_ENV`       | Must be `"production"` (already set in wrangler.toml)    |
| `LIVEKIT_URL`    | LiveKit server URL (`wss://your-project.livekit.cloud`)  |
| `ALLOWED_ORIGINS`| Comma-separated approved CORS origins                    |

## 3. D1 Database Setup

The `wrangler.toml` contains a **placeholder `database_id`** (`00000000-0000-0000-0000-000000000000`). Replace it with your real D1 database ID before deploying:

```bash
# Create the D1 database and note the database_id in output
wrangler d1 create lbv-sales-sessions

# Edit wrangler.toml: replace the placeholder database_id with the real one

# Apply D1 schema migrations
wrangler d1 migrations apply lbv-sales-sessions --remote
```

## 4. CORS Configuration

In production (or when `NODE_ENV` is absent in a Cloudflare Worker environment), CORS is fail-closed: requests with missing or untrusted origins receive `Access-Control-Allow-Origin: null`. Absent `NODE_ENV` in a Worker environment is treated as production — permissive dev CORS is never accidentally enabled.

Set `ALLOWED_ORIGINS` to your production frontend domains:
```
ALLOWED_ORIGINS=https://your-store.myshopify.com,https://dashboard.yourdomain.com
```

## 5. Deployment Steps

```bash
# Install dependencies
npm install --legacy-peer-deps

# TypeScript check (must pass with 0 errors)
node_modules/.bin/tsc --noEmit

# Run the complete deterministic validation suite (all eight suites).
# See section 5.1 for per-suite commands.
GEMINI_API_KEY=dummy node_modules/.bin/tsx run-tests.ts hardening

# Build static assets
npm run build

# Deploy to Cloudflare Workers
wrangler deploy
```

## 5.1 Running the Validation Test Suites

The test runner is `run-tests.ts`, invoked through `tsx`. For the deterministic suites below, `GEMINI_API_KEY=dummy` is sufficient. The separate `adversarial`, `stage2`, and `classification` commands require a real `GEMINI_API_KEY` and are not part of the eight deterministic validation suites.

### Run the complete suite (all eight suites)

There **is** a single command that runs all eight deterministic validation suites in one process:

```bash
GEMINI_API_KEY=dummy node_modules/.bin/tsx run-tests.ts hardening
# or, equivalently:
GEMINI_API_KEY=dummy npm run test:hardening
```

> **Naming note:** despite its name, the `hardening` command is **not** hardening-only. Its handler runs all eight suites (hardening unit, approval gate, adapter isolation, session access control, realtime, session persistence, D1 persistence, and worker integration). There is currently no command that runs the hardening suite by itself.

### Run the individual suites

| # | Suite | Command |
|---|-------|---------|
| 1 | Hardening unit tests | *(no standalone command — runs only as part of `hardening`)* |
| 2 | Approval gate | `npm run test:approval-gate` |
| 3 | Adapter isolation | `npm run test:isolation` |
| 4 | Session access control | `GEMINI_API_KEY=dummy node_modules/.bin/tsx run-tests.ts access-control` |
| 5 | Realtime (LiveKit) | `GEMINI_API_KEY=dummy node_modules/.bin/tsx run-tests.ts realtime` |
| 6 | Session persistence | `GEMINI_API_KEY=dummy node_modules/.bin/tsx run-tests.ts persistence` |
| 7 | D1 persistence | `npm run test:d1` |
| 8 | Worker integration | `npm run test:worker` |

## 6. Switching LLM Providers

The `ModelProvider` interface decouples the engine from Gemini. To switch (e.g., to Groq or another OpenAI-compatible endpoint):
1. Implement `ModelProvider` in a new file (e.g., `lbv-sales-copilot/engine/groq-provider.ts`).
2. Update provider instantiation in `worker.ts`.
3. Add the new API key as a Worker Secret.
No changes to engine, adapters, or session management are needed.

## 7. Remaining Blockers for Production

The following must be supplied by the project owner before going live:

- **Real D1 `database_id`** — replace placeholder UUID in `wrangler.toml`
- **`GEMINI_API_KEY`** — `wrangler secret put GEMINI_API_KEY`
- **`LIVEKIT_API_KEY`** and **`LIVEKIT_API_SECRET`** — `wrangler secret put`
- **`LIVEKIT_URL`** — set in Cloudflare dashboard vars
- **`ADMIN_API_KEY`** — `wrangler secret put ADMIN_API_KEY`
- **`ALLOWED_ORIGINS`** — set in Cloudflare dashboard vars with production frontend domains
