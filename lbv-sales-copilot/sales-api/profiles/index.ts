/**
 * Service profile registry helpers.
 *
 * Adding a new service = add a profile file and append it to ALL_SERVICE_PROFILES.
 * No core engine, provider, or template changes are required.
 */

import { ServiceProfile } from "../../engine/service-profile.js";
import { ProfileBackedSalesAdapter } from "../../engine/profile-adapter.js";
import { AdapterRegistry } from "../../engine/adapter-registry.js";
import { SHOPIFY_SERVICE_PROFILE } from "./shopify.profile.js";
import { GHOSTWRITER_SERVICE_PROFILE } from "./ghostwriter.profile.js";
import { CLIPPING_SERVICE_PROFILE } from "./clipping.profile.js";

export { SHOPIFY_SERVICE_PROFILE, GHOSTWRITER_SERVICE_PROFILE, CLIPPING_SERVICE_PROFILE };

/** All representative service profiles supported out of the box. */
export const ALL_SERVICE_PROFILES: ServiceProfile[] = [
  SHOPIFY_SERVICE_PROFILE,
  GHOSTWRITER_SERVICE_PROFILE,
  CLIPPING_SERVICE_PROFILE
];

/** Builds one adapter per registered profile. */
export function createProfileAdapters(): ProfileBackedSalesAdapter[] {
  return ALL_SERVICE_PROFILES.map((profile) => new ProfileBackedSalesAdapter(profile));
}

/**
 * Registers every service profile (or a subset by canonical id) into an
 * AdapterRegistry. Returns the adapters that were registered.
 */
export function registerServiceProfiles(
  registry: AdapterRegistry,
  options: { includeIds?: string[] } = {}
): ProfileBackedSalesAdapter[] {
  const adapters = createProfileAdapters().filter(
    (a) => !options.includeIds || options.includeIds.includes(a.id)
  );
  for (const adapter of adapters) {
    registry.register(adapter, adapter.getProfile().aliases || []);
  }
  return adapters;
}
