import { PhoneCall, Radio, Server, ShieldCheck, ArrowRight, ListChecks } from "lucide-react";
import { useSession } from "../SessionContext";
import { useAdapters } from "../useAdapters";
import { useLiveKitStatus } from "../useLiveKitStatus";
import { DashboardRoute } from "../useHashRoute";
import { Alert, Badge, Button, Card, CardHeader, IdText, SectionHeader, StatusDot } from "../components/ui";
import { InviteLinkPanel } from "../components/InviteLinkPanel";

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

export function DashboardHome({ onNavigate }: { onNavigate: (r: DashboardRoute) => void }) {
  const { activeSession, calls, endActiveSession } = useSession();
  const { nameFor } = useAdapters();
  const { status: liveKit, error: liveKitError, refresh } = useLiveKitStatus();

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Dashboard"
        description="Start a sales call, share the invitation, and run the conversation with live AI guidance."
        actions={
          <>
            <Button variant="secondary" onClick={() => onNavigate("live-room")} disabled={!activeSession}>
              <Radio className="h-4 w-4" />
              Open live room
            </Button>
            <Button variant="primary" onClick={() => onNavigate("new-call")}>
              <PhoneCall className="h-4 w-4" />
              New sales call
            </Button>
          </>
        }
      />

      {activeSession ? (
        <Card>
          <CardHeader
            title="Active sales session"
            description="Your invitation is live. The prospect joins the same room from their own device."
            icon={<Radio className="h-4 w-4" />}
            actions={
              <Badge tone={activeSession.status === "ended" ? "neutral" : "positive"}>
                <StatusDot
                  tone={activeSession.status === "ended" ? "neutral" : "positive"}
                  pulse={activeSession.status !== "ended"}
                />
                {activeSession.status === "ended" ? "Ended" : "Ready for prospect"}
              </Badge>
            }
          />
          <div className="space-y-5 px-5 py-5">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-[12px] uppercase tracking-wide text-ink-mute">Session ID</dt>
                <dd className="mt-1">
                  <IdText>{activeSession.sessionId}</IdText>
                </dd>
              </div>
              <div>
                <dt className="text-[12px] uppercase tracking-wide text-ink-mute">Service</dt>
                <dd className="mt-1 text-[13px] text-ink">{nameFor(activeSession.productId)}</dd>
              </div>
              <div>
                <dt className="text-[12px] uppercase tracking-wide text-ink-mute">Created</dt>
                <dd className="mt-1 text-[13px] text-ink-soft">{formatTime(activeSession.createdAt)}</dd>
              </div>
            </dl>

            {activeSession.inviteUrl ? (
              <InviteLinkPanel
                inviteUrl={activeSession.inviteUrl}
                sessionId={activeSession.sessionId}
                onOpenRoom={() => onNavigate("live-room")}
              />
            ) : (
              <Alert tone="warn" title="Invitation link unavailable">
                This session was created without an invitation token. Create a new session to generate a fresh link.
              </Alert>
            )}

            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              <Button variant="primary" onClick={() => onNavigate("live-room")}>
                <Radio className="h-4 w-4" />
                Open Live Sales Room
              </Button>
              <Button variant="secondary" onClick={() => onNavigate("new-call")}>
                <PhoneCall className="h-4 w-4" />
                Start another call
              </Button>
              <Button variant="ghost" onClick={() => void endActiveSession()}>
                End session
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Start a sales call"
              description="Choose a service profile, create a session, and share the prospect invitation."
              icon={<PhoneCall className="h-4 w-4" />}
            />
            <div className="px-5 py-5">
              <ol className="space-y-4">
                {[
                  {
                    title: "Create the session",
                    body: "Pick the service you are selling. The backend issues a session and a scoped invitation token.",
                  },
                  {
                    title: "Share the invitation",
                    body: "Send the audio-only link with your device's share sheet or copy it to the clipboard.",
                  },
                  {
                    title: "Run the call",
                    body: "Open the Live Sales Room for the transcript and private, approval-gated AI guidance.",
                  },
                ].map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-[12px] font-semibold text-ink-soft">
                      {index + 1}
                    </span>
                    <div>
                      <p className="text-[13.5px] font-medium text-ink">{step.title}</p>
                      <p className="text-[13px] text-ink-soft">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-6">
                <Button variant="primary" size="lg" onClick={() => onNavigate("new-call")}>
                  <PhoneCall className="h-4 w-4" />
                  New sales call
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="This browser" icon={<ListChecks className="h-4 w-4" />} />
            <div className="space-y-3 px-5 py-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[13px] text-ink-soft">Sessions created</span>
                <span className="font-mono text-lg text-ink">{calls.length}</span>
              </div>
              <p className="text-[12px] text-ink-mute">
                Sessions are tracked in memory for this tab only. The backend intentionally prevents global session
                listing across salespeople, so no cross-device history is shown.
              </p>
              <Button variant="ghost" size="sm" onClick={() => onNavigate("history")}>
                View call history
              </Button>
            </div>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader
          title="Realtime connection"
          description="Live audio and transcription require LiveKit Cloud credentials configured on the Worker."
          icon={<Server className="h-4 w-4" />}
          actions={
            <Button variant="ghost" size="sm" onClick={refresh}>
              Refresh
            </Button>
          }
        />
        <div className="px-5 py-5">
          {liveKitError ? (
            <Alert tone="danger" title="Could not read LiveKit status">
              {liveKitError}
            </Alert>
          ) : liveKit === null ? (
            <p className="text-[13px] text-ink-soft">Checking configuration…</p>
          ) : liveKit.configured ? (
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="positive">
                <ShieldCheck className="h-3.5 w-3.5" />
                LiveKit Cloud configured
              </Badge>
              {liveKit.serverUrl && <IdText className="text-ink-soft">{liveKit.serverUrl}</IdText>}
            </div>
          ) : (
            <Alert tone="warn" title="LiveKit Cloud is not configured">
              The Worker is missing <code className="font-mono">LIVEKIT_URL</code>,{" "}
              <code className="font-mono">LIVEKIT_API_KEY</code>, or{" "}
              <code className="font-mono">LIVEKIT_API_SECRET</code>. Live calls and transcription stay unavailable
              until these Worker secrets/vars are set.
            </Alert>
          )}
        </div>
      </Card>
    </div>
  );
}

