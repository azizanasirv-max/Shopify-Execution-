import { useCallback, useMemo, useState } from "react";
import { Check, Copy, Link2, Share2, TriangleAlert } from "lucide-react";
import { Button, cn, Field } from "./ui";
import { copyToClipboard, resolveShareDependencies, shareInvitation } from "../share";

type Feedback = { tone: "positive" | "warn"; message: string } | null;

export interface InviteLinkPanelProps {
  inviteUrl: string;
  sessionId: string;
  onOpenRoom?: () => void;
}

/**
 * Copy / native-share controls for a prospect invitation link.
 *
 * The link is rendered read-only and is never persisted. Sharing prefers the
 * device share sheet and transparently falls back to the clipboard.
 */
export function InviteLinkPanel({ inviteUrl, sessionId, onOpenRoom }: InviteLinkPanelProps) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const deps = useMemo(() => resolveShareDependencies(), []);
  const canNativeShare = Boolean(deps.share);

  const flash = useCallback((next: Feedback) => {
    setFeedback(next);
    window.setTimeout(() => setFeedback(null), 3500);
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(inviteUrl, deps);
    flash(
      ok
        ? { tone: "positive", message: "Invitation link copied to clipboard." }
        : { tone: "warn", message: "Could not access the clipboard. Select the link and copy it manually." }
    );
  }, [deps, flash, inviteUrl]);

  const handleShare = useCallback(async () => {
    const outcome = await shareInvitation(
      {
        title: "Join my LBV sales call",
        text: "You're invited to a private, audio-only sales call.",
        url: inviteUrl,
      },
      deps
    );
    if (outcome.method === "clipboard") {
      flash({ tone: "positive", message: "Link copied — paste it into any app to share." });
    } else if (outcome.method === "manual") {
      flash({ tone: "warn", message: "Sharing isn't available here. Select the link and copy it manually." });
    } else if (outcome.method === "native") {
      flash({ tone: "positive", message: "Share sheet opened." });
    }
  }, [deps, flash, inviteUrl]);

  return (
    <div className="space-y-3">
      <Field label="Prospect invitation link" htmlFor={`invite-${sessionId}`}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-mute" />
            <input
              id={`invite-${sessionId}`}
              readOnly
              value={inviteUrl}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Prospect invitation link"
              className="w-full rounded-lg border border-line bg-canvas py-2.5 pl-9 pr-3 font-mono text-[12px] text-ink-soft focus:border-brand focus:outline-none"
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={handleCopy} className="shrink-0">
              <Copy className="h-4 w-4" />
              Copy
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleShare}
              className="shrink-0"
              title={canNativeShare ? "Share via your device" : "Copy to share (native share unavailable)"}
            >
              <Share2 className="h-4 w-4" />
              Share
            </Button>
          </div>
        </div>
      </Field>

      <p className="text-[12px] text-ink-mute">
        Audio-only invitation. The prospect sees a dedicated call page — never your dashboard, notes, or AI guidance.
      </p>

      {feedback && (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2 text-[12px]",
            feedback.tone === "positive" ? "text-positive" : "text-warn"
          )}
        >
          {feedback.tone === "positive" ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <TriangleAlert className="h-3.5 w-3.5" />
          )}
          {feedback.message}
        </div>
      )}

      {onOpenRoom && (
        <div className="pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onOpenRoom}>
            Open the Live Sales Room →
          </Button>
        </div>
      )}
    </div>
  );
}
