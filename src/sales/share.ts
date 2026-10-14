/**
 * Sharing helpers (pure, injectable dependencies for testability).
 *
 * Preference order for sharing an invitation link:
 *   1. The device's native share sheet (Web Share API), when supported.
 *   2. Clipboard copy, as a universal fallback.
 *   3. "manual" — surface the link so the user can copy it themselves.
 */

export interface SharePayload {
  title?: string;
  text?: string;
  url: string;
}

export interface ShareDependencies {
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
}

export type ShareOutcome =
  | { method: "native"; url: string }
  | { method: "clipboard"; url: string }
  | { method: "manual"; url: string }
  | { method: "cancelled"; url: string };

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError");
}

/**
 * Share an invitation link using the best available mechanism.
 * Never throws: a failed native share falls back to the clipboard, and a failed
 * clipboard falls back to "manual" so the caller can display the link.
 */
export async function shareInvitation(
  payload: SharePayload,
  deps: ShareDependencies
): Promise<ShareOutcome> {
  const { url } = payload;

  if (deps.share) {
    try {
      await deps.share({ title: payload.title, text: payload.text, url });
      return { method: "native", url };
    } catch (err) {
      // The user dismissing the share sheet is not a failure — do not also copy.
      if (isAbortError(err)) return { method: "cancelled", url };
      // Any other error: fall through to the clipboard.
    }
  }

  if (deps.clipboard) {
    try {
      await deps.clipboard.writeText(url);
      return { method: "clipboard", url };
    } catch {
      // fall through to manual
    }
  }

  return { method: "manual", url };
}

/**
 * Resolve the sharing dependencies from a global object (window/navigator).
 * Returns an empty dependency set in non-browser environments.
 */
export function resolveShareDependencies(scope?: {
  navigator?: {
    share?: ShareDependencies["share"];
    clipboard?: ShareDependencies["clipboard"];
  };
}): ShareDependencies {
  const nav = scope?.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (!nav) return {};

  const deps: ShareDependencies = {};
  if (typeof nav.share === "function") {
    deps.share = (data) => nav.share!(data);
  }
  if (nav.clipboard && typeof nav.clipboard.writeText === "function") {
    deps.clipboard = { writeText: (text) => nav.clipboard!.writeText(text) };
  }
  return deps;
}

/** Copy text to the clipboard, returning whether it succeeded. */
export async function copyToClipboard(text: string, deps: ShareDependencies): Promise<boolean> {
  if (!deps.clipboard) return false;
  try {
    await deps.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
