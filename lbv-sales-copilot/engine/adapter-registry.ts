/**
 * Adapter Registry for Generic Sales Engine
 *
 * Implements a server-side registry of approved product adapters.
 * Guarantees:
 * 1. Explicit adapter resolution by product identifier or registered alias.
 * 2. Rejection of unknown product identifiers with an explicit error (fail-closed).
 * 3. Never silently falls back to Shopify or any default adapter.
 * 4. Extensible without modifying GenericSalesEngine code.
 */

import { SalesApiAdapter } from "./types.js";

export class UnknownProductError extends Error {
  public readonly code = "UNKNOWN_PRODUCT";
  constructor(public readonly productId: string) {
    super(`Unknown or unregistered product identifier: '${productId}'. Must be an approved registered adapter.`);
    this.name = "UnknownProductError";
  }
}

export interface AdapterSummary {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  toolsCount: number;
}

export class AdapterRegistry {
  private adaptersById = new Map<string, SalesApiAdapter>();
  private aliasToId = new Map<string, string>();

  /**
   * Register an approved product adapter with optional aliases.
   *
   * @param adapter The SalesApiAdapter implementation
   * @param aliases Alternate identifiers (e.g., ['shopify'] for 'shopify-conversion-pilot')
   */
  public register(adapter: SalesApiAdapter, aliases: string[] = []): void {
    if (!adapter || !adapter.id) {
      throw new Error("Cannot register an adapter without a valid id.");
    }

    const canonicalId = adapter.id;
    this.adaptersById.set(canonicalId, adapter);
    this.aliasToId.set(canonicalId.toLowerCase(), canonicalId);

    for (const alias of aliases) {
      if (alias && typeof alias === "string") {
        this.aliasToId.set(alias.toLowerCase().trim(), canonicalId);
      }
    }
  }

  /**
   * Check if a product identifier or alias is registered.
   */
  public has(productId: string): boolean {
    if (!productId || typeof productId !== "string") {
      return false;
    }
    const resolvedId = this.aliasToId.get(productId.toLowerCase().trim());
    return !!resolvedId && this.adaptersById.has(resolvedId);
  }

  /**
   * Resolve an adapter by product id or alias.
   * Throws UnknownProductError if not found.
   * NEVER silently substitutes Shopify or any other adapter.
   */
  public resolve(productId: string): SalesApiAdapter {
    if (!productId || typeof productId !== "string" || !productId.trim()) {
      throw new UnknownProductError(productId || "EMPTY_PRODUCT_ID");
    }

    const resolvedId = this.aliasToId.get(productId.toLowerCase().trim());
    if (!resolvedId) {
      throw new UnknownProductError(productId);
    }

    const adapter = this.adaptersById.get(resolvedId);
    if (!adapter) {
      throw new UnknownProductError(productId);
    }

    return adapter;
  }

  /**
   * Return canonical adapter ID for any recognized alias or ID.
   */
  public getCanonicalId(productId: string): string | undefined {
    if (!productId || typeof productId !== "string") return undefined;
    return this.aliasToId.get(productId.toLowerCase().trim());
  }

  /**
   * Return all unique registered adapters.
   */
  public getAll(): SalesApiAdapter[] {
    return Array.from(this.adaptersById.values());
  }

  /**
   * Get metadata summaries of all registered adapters for discovery.
   */
  public getSummaries(): AdapterSummary[] {
    return this.getAll().map(adapter => {
      const aliases: string[] = [];
      for (const [alias, id] of this.aliasToId.entries()) {
        if (id === adapter.id && alias !== adapter.id.toLowerCase()) {
          aliases.push(alias);
        }
      }
      return {
        id: adapter.id,
        name: adapter.name,
        description: adapter.description,
        aliases,
        toolsCount: adapter.getTools().length
      };
    });
  }
}
