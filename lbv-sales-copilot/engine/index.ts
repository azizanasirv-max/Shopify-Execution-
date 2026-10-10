/**
 * Product-Independent Sales Engine
 * Barrel export for core engine, adapters, and interfaces.
 */

export * from "./types.js";
export * from "./generic-sales-engine.js";
export * from "./realtime-adapter.js";
export * from "./session-manager.js";
export * from "./adapter-registry.js";
export { ShopifySalesAdapter } from "../sales-api/shopify-adapter.js";
export { GhostwriterSalesAdapter } from "../sales-api/ghostwriter-adapter.js";
