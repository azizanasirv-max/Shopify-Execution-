# LBV Sales Copilot — Stage 1 Architecture

This document defines the Stage 1 foundational architecture of the **LBV Sales Copilot** system. The objective of Stage 1 is to build and validate the deterministic **Sales Brain** and its restricted tools.

## System Topology & Flow

```
+-----------------------------------------------------------+
|                     Developer Validation UI                |
|  - Realtime scenario selection                            |
|  - Prospect query submission                              |
|  - Tool invocation log viewer                             |
|  - Grounding scorecard & "SAY THIS NEXT" direct script     |
+-----------------------------+-----------------------------+
                              |
                     POST /api/copilot
                              |
                              v
+-----------------------------+-----------------------------+
|               Express Server API Gateway                  |
|  - Initiates Gemini Flash LLM loop                        |
|  - Handles LLM tool calls (Function Calling)              |
|  - Strictly dispatches to Node tools                      |
+----------------------+----------------------+--------------+
                       |                      |
                       v                      v
             +---------+----------+  +--------+---------+
             |   Local API Tools  |  |    Static Data   |
             |  - getProspect()   |  |  - test-prospect |
             |  - getAudit()      |  |    .json         |
             |  - getEvidence()   |  +------------------+
             |  - getOffer()      |
             +--------------------+
```

## Core Components

1. **Deterministic Test Prospect Storage (`/sales-api/data/test-prospect.json`)**
   Stores fully deterministic, verified storefront and listing data for `Example Fashion Store`. Includes rating, review count, active status, audit findings, evidence, and pilots. Strictly flags critical internal metrics (CAC, Conversion Rate, Profits, exact Revenues) as `UNAVAILABLE`.

2. **Restricted Local API Tools (`/sales-api/tools/`)**
   - `getProspect()`: Returns brand name, platform, active status, and public metrics.
   - `getAudit()`: Returns standard non-destructive storefront audit findings.
   - `getEvidence()`: Returns detailed visual evidence items.
   - `getOffer()`: Returns pilot price ($400), recurring monthly rate ($900), and pilot scope.

3. **Sales Brain Policy Engine (`/lib/sales-context.ts`)**
   Houses the master system rules and prompt instructions for the Gemini LLM. Contains an automated client-and-server side parser to audit responses for compliance against the 10 core constraints (e.g., verifying that conversion rates or revenues were not fabricated).

4. **15 Validation Scenarios (`/scenarios/sales-scenarios.json`)**
   A structured test suite representing common sales objections, queries, and scenarios. Each scenario is mapped to explicit compliance rules detailing what the model MUST and MUST NOT output.

5. **Validation UI (`/app/page.tsx`)**
   A minimal, developer-centric environment allowing immediate, single-click testing of all scenarios, with dynamic API tool log outputs, automated grounding scorecards, and live rule-compliance flags.
