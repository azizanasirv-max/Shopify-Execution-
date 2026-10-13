#!/usr/bin/env node
/**
 * Pre-deploy configuration guard.
 *
 * Fails clearly (non-zero exit) when wrangler.toml still contains the
 * environment-specific D1 placeholder, so a placeholder can never be silently
 * treated as production-ready. Also sanity-checks the static assets config.
 *
 * This script performs NO network calls and does NOT touch any remote database.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = path.join(root, "wrangler.toml");

const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

function fail(lines) {
  console.error("\n[check:deploy] DEPLOYMENT BLOCKED\n");
  for (const line of lines) console.error("  - " + line);
  console.error("\nSee DEPLOYMENT.md for the safe D1 setup sequence.\n");
  process.exit(1);
}

if (!fs.existsSync(wranglerPath)) {
  fail(["wrangler.toml was not found at " + wranglerPath]);
}

const config = fs.readFileSync(wranglerPath, "utf-8");
const errors = [];

// 1. D1 database id must be real.
const idMatch = config.match(/^\s*database_id\s*=\s*"([^"]*)"/m);
if (!idMatch) {
  errors.push("No [[d1_databases]].database_id found in wrangler.toml.");
} else if (idMatch[1] === PLACEHOLDER_DATABASE_ID || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(idMatch[1])) {
  errors.push(
    `database_id is still the placeholder (${idMatch[1]}). Create a real D1 database and set its id in wrangler.toml.`
  );
}

// 2. Static assets must use the modern [assets] config, not the legacy [site].
if (/^\s*\[site\]/m.test(config)) {
  errors.push("Legacy [site] configuration detected. Use [assets] with binding = \"ASSETS\".");
}
if (!/^\s*\[assets\]/m.test(config)) {
  errors.push("Missing [assets] configuration for the built frontend.");
} else {
  if (!/^\s*binding\s*=\s*"ASSETS"/m.test(config)) {
    errors.push('[assets] must declare binding = "ASSETS" to match env.ASSETS in worker.ts.');
  }
  if (!/^\s*directory\s*=\s*"\.\/dist"/m.test(config)) {
    errors.push('[assets] should point directory at "./dist" (the Vite build output).');
  }
}

if (errors.length > 0) {
  fail(errors);
}

console.log("[check:deploy] wrangler.toml looks deployable (real D1 id, modern [assets] config).");
