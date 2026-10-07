# LBV Sales Copilot - Stage 1

This folder contains the complete, self-contained Next.js project structure for **Stage 1: Sales Brain Foundation**.

## Overview
Stage 1 focuses exclusively on establishing a grounded, deterministic Sales Brain backed by strict, factual API tools. This ensures that the copilot provides highly accurate recommended statements without fabricating metrics like revenue, CAC, or conversion rates.

## Core Structure
- `app/page.tsx`: Simple validation dashboard for testing scenarios and seeing real-time tool logs and grounding checks.
- `sales-api/data/test-prospect.json`: Central repository of deterministic prospect facts.
- `sales-api/tools/`: Local Node.js tool implementations returning verified JSON slices.
- `scenarios/sales-scenarios.json`: Mapped set of 15 key sales scenarios with expected responses and grounding rules.
- `lib/sales-context.ts`: Shared configuration and system prompt rules for LLM evaluation.

## Standalone Running
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment:
   ```bash
   cp .env.example .env
   # Add your GEMINI_API_KEY
   ```
3. Run the Next.js app locally:
   ```bash
   npm run dev
   ```
