/**
 * Invitation-link helpers (pure, framework-free).
 *
 * SECURITY CONTRACT
 * - An invitation link carries ONLY the scoped, single-session invitation token
 *   plus the session id. It must never carry the salesperson's session
 *   authorization token.
 * - These helpers never touch browser storage; tokens stay in memory only.
 */

export interface ProspectInvite {
  sessionId: string;
  token: string;
}

/**
 * True when the current URL is a prospect invitation route.
 * The salesperson dashboard must never render on this route.
 */
export function isProspectRoute(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("join") === "1" || params.get("prospect") === "1";
}

/** Extract the invitation credentials from a prospect URL. */
export function parseProspectInvite(search: string): ProspectInvite {
  const params = new URLSearchParams(search);
  return {
    sessionId: params.get("sessionId") || "",
    token: params.get("token") || "",
  };
}

/**
 * Build the prospect invitation URL for a session.
 *
 * @throws if the session id or invitation token is missing, so a malformed or
 *         token-less link can never be produced or shared.
 */
export function buildInviteUrl(
  origin: string,
  pathname: string,
  sessionId: string,
  inviteToken: string
): string {
  if (!sessionId) throw new Error("Cannot build an invitation link without a session id.");
  if (!inviteToken) throw new Error("Cannot build an invitation link without an invitation token.");

  const base = `${origin}${pathname}`;
  const params = new URLSearchParams({
    join: "1",
    sessionId,
    token: inviteToken,
  });
  return `${base}?${params.toString()}`;
}

/**
 * The URL the prospect page shows AFTER the invitation has been validated: the
 * invitation token is dropped from the address bar, history, and referrer.
 */
export function toValidatedProspectUrl(pathname: string): string {
  return `${pathname}?join=1`;
}

/** True when the URL still exposes an invitation token. */
export function urlExposesToken(search: string): boolean {
  return search.includes("token=");
}
