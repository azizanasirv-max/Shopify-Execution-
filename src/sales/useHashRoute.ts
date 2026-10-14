import { useCallback, useEffect, useState } from "react";

/**
 * Hash-based routing for the salesperson dashboard.
 *
 * The root path renders the dashboard; sections are addressed with a hash so
 * they are deep-linkable and the browser back button works. Prospect
 * invitations are detected from the query string (see invite.ts), not the hash.
 */

export const DASHBOARD_ROUTES = [
  "dashboard",
  "new-call",
  "live-room",
  "history",
  "profiles",
  "settings",
] as const;

export type DashboardRoute = (typeof DASHBOARD_ROUTES)[number];

export const DEFAULT_ROUTE: DashboardRoute = "dashboard";

function isDashboardRoute(value: string): value is DashboardRoute {
  return (DASHBOARD_ROUTES as readonly string[]).includes(value);
}

/** Parse a location hash (e.g. "#/new-call") into a known route. */
export function parseRoute(hash: string): DashboardRoute {
  const cleaned = hash.replace(/^#\/?/, "").split("?")[0].split("/")[0].trim();
  return isDashboardRoute(cleaned) ? cleaned : DEFAULT_ROUTE;
}

export function routeToHash(route: DashboardRoute): string {
  return `#/${route}`;
}

export function useHashRoute(): [DashboardRoute, (route: DashboardRoute) => void] {
  const [route, setRoute] = useState<DashboardRoute>(() =>
    typeof window === "undefined" ? DEFAULT_ROUTE : parseRoute(window.location.hash)
  );

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: DashboardRoute) => {
    const hash = routeToHash(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(next);
  }, []);

  return [route, navigate];
}
