# syntax=docker/dockerfile:1
#
# LBV Sales Engine - LiveKit Cloud agent image.
#
# This image runs the EXISTING agent in this directory (`agent.ts`) unchanged:
#   node --import tsx agent.ts start
#
# LiveKit Cloud requirements implemented here (see
# https://docs.livekit.io/deploy/agents/builds/):
#   * glibc base image (Debian slim) - Alpine/musl is NOT supported.
#   * `ca-certificates` installed: the LiveKit SDK needs the system CA bundle to
#     reach LiveKit Cloud, otherwise `Room.connect()` fails with
#     "failed to retrieve region info".
#   * runs as an unprivileged user (appuser), never root.
#   * fixed startup command (CMD) - LiveKit Cloud does not run arbitrary shells.
#   * NO LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET (and no
#     ASSEMBLYAI_API_KEY) are baked in. LiveKit Cloud injects the LiveKit
#     credentials automatically and the agent secrets are stored via LiveKit
#     Cloud secrets management at deploy time.
#
# NOTE: `npm ci --omit=dev` is used, so every runtime import (including `tsx`)
# must be a production dependency in package.json.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

# HOME is required for the npm/tsx cache and for any model cache writes; the
# non-root user below owns /app so it can write there.
ENV HOME=/app

# System CA bundle + a clean apt layer (keeps the image small).
RUN apt-get update -qq \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- Build stage -----------------------------------------------------------
FROM base AS build

WORKDIR /app

# Dependency manifests first so the dependency layer is cached across code edits.
COPY package.json package-lock.json ./

# Reproducible, production-only install (tsx is a production dependency).
RUN npm ci --omit=dev --no-audit --no-fund

# Pre-download plugin dependency files (Silero VAD / ONNX assets). Runs before
# the source copy so it stays cached when only agent code changes. The standalone
# `livekit-agents` CLI discovers installed @livekit/agents-plugin-* packages
# without loading the agent code.
RUN ./node_modules/.bin/livekit-agents download-files

# Copy the agent source (node_modules / .env* are excluded by .dockerignore).
COPY . .

# --- Production stage ------------------------------------------------------
FROM base

ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

WORKDIR /app

COPY --from=build --chown=appuser:appuser /app /app

USER appuser

ENV NODE_ENV=production

# Start the LiveKit worker in production mode. It connects to the LiveKit Cloud
# project (credentials injected by LiveKit Cloud at runtime) and waits for room
# dispatch. With no agent name configured it uses AUTOMATIC dispatch, so it
# joins every new room in the project.
CMD ["node", "--import", "tsx", "agent.ts", "start"]
