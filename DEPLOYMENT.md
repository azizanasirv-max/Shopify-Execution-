# LBV Sales Engine — Production Deployment Guide

This document outlines the architecture, deployment strategy, and configuration for deploying the LBV Sales Engine on **Cloudflare Pages** (frontend) and **Cloudflare Workers / Node.js runtime** (backend API), utilizing **LiveKit Cloud** for audio transport and **AssemblyAI** for streaming speech-to-text.

---

## 1. Architecture Overview

- **Frontend (React 19 + Vite + Tailwind CSS):**
  - Hosted on **Cloudflare Pages**.
  - Built via `npm run build` which compiles static assets into `dist/`.
  - Connects to LiveKit Cloud for real-time sales call audio transport and streams transcriptions via the Express API / Cloudflare Worker backend.

- **Backend Sales Engine & API (Express + TypeScript):**
  - Hosted on Node.js-compatible environments or adapted for Cloudflare Workers via Wrangler.
  - Implements deterministic approval gates, product adapters (Shopify, Ghostwriter, etc.), session authorization, and bounded conversation history management.

- **Session Persistence:**
  - **Local Development / Tests:** In-memory store (`InMemorySessionStore`) or single-instance durable file storage (`FileSessionStore` with atomic file replacement and concurrency mutex).
  - **Cloudflare Workers Production:** Bound to Cloudflare KV (`LBV_SESSIONS_KV`) or persistent distributed storage ensuring isolated, product-bound session states without cross-user leakage.

---

## 2. Environment Variables

Required environment variables in production (`.env` or Cloudflare dashboard secrets / vars):

```env
PORT=3000
NODE_ENV=production
GEMINI_API_KEY=your_gemini_api_key_here
LIVEKIT_API_KEY=your_livekit_api_key_here
LIVEKIT_API_SECRET=your_livekit_api_secret_here
LIVEKIT_URL=wss://your-livekit-instance.livekit.cloud
LBV_SESSION_FILE_PATH=./data/sessions.json
```

---

## 3. Wrangler Configuration (`wrangler.toml`)

The repository includes `wrangler.toml` configured for Cloudflare Workers and Pages static asset serving:

```toml
name = "lbv-sales-copilot"
main = "server.ts"
compatibility_date = "2024-03-20"

[site]
bucket = "dist"

[vars]
NODE_ENV = "production"

[[kv_namespaces]]
binding = "LBV_SESSIONS_KV"
id = "lbv_sessions_kv_placeholder_id"
production_id = "lbv_sessions_kv_production_id"
```

---

## 4. Build & Deployment Steps

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Run Test Suites:**
   ```bash
   npm run test:isolation
   npm run test:hardening
   npm run test:approval-gate
   npx tsx run-tests.ts persistence
   ```

3. **Type Check & Build:**
   ```bash
   npm run lint
   npm run build
   ```

4. **Deploy to Cloudflare:**
   - **Frontend (Pages):** Deploy the `dist/` directory to Cloudflare Pages.
   - **Backend (Workers):** Deploy using Wrangler:
     ```bash
     npx wrangler deploy
     ```
