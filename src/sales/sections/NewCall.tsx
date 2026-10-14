import { useEffect, useMemo, useState } from "react";
import { Layers, PhoneCall, Radio, RefreshCw } from "lucide-react";
import { useSession } from "../SessionContext";
import { useAdapters } from "../useAdapters";
import { DashboardRoute } from "../useHashRoute";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  IdText,
  SectionHeader,
  Spinner,
  StatusDot,
  cn,
} from "../components/ui";
import { InviteLinkPanel } from "../components/InviteLinkPanel";

const PREFERRED_PROFILE_KEY = "lbv.preferredProfile";

function readPreferredProfile(): string | null {
  try {
    return window.localStorage.getItem(PREFERRED_PROFILE_KEY);
  } catch {
    return null;
  }
}

function writePreferredProfile(productId: string): void {
  try {
    window.localStorage.setItem(PREFERRED_PROFILE_KEY, productId);
  } catch {
    /* preference persistence is optional */
  }
}

export function NewCall({ onNavigate }: { onNavigate: (r: DashboardRoute) => void }) {
  const { activeSession, startSession, starting } = useSession();
  const { adapters, loading, error: adaptersError, reload } = useAdapters();

  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Preselect the remembered profile, else the first available one.
  useEffect(() => {
    if (selected || adapters.length === 0) return;
    const preferred = readPreferredProfile();
    const preferredExists = preferred && adapters.some((a) => a.id === preferred);
    setSelected(preferredExists ? preferred : adapters[0].id);
  }, [adapters, selected]);

  const selectedAdapter = useMemo(
    () => adapters.find((a) => a.id === selected) ?? null,
    [adapters, selected]
  );

  const handleCreate = async () => {
    if (!selected) {
      setError("Select a service profile before creating the session.");
      return;
    }
    setError(null);
    try {
      await startSession(selected);
      writePreferredProfile(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the session. Please try again.");
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="New Sales Call"
        description="Create a session for the service you are selling, then share the invitation link with your prospect."
      />

      {activeSession && activeSession.status !== "ended" && (
        <Alert tone="brand" title="You already have an active session">
          <div className="flex flex-wrap items-center gap-3">
            <span>Creating a new session will switch the active room. The current session stays in Call History.</span>
            <Button size="sm" variant="secondary" onClick={() => onNavigate("live-room")}>
              <Radio className="h-3.5 w-3.5" /> Open current room
            </Button>
          </div>
        </Alert>
      )}

      {/* Step 1 — service profile */}
      <Card>
        <CardHeader
          title="1. Service profile"
          description="The offering, audience, and playbook used to ground every AI recommendation."
          icon={<Layers className="h-4 w-4" />}
          actions={
            <Button variant="ghost" size="sm" onClick={reload} disabled={loading}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </Button>
          }
        />
        <div className="px-5 py-5">
          {loading ? (
            <div className="flex items-center gap-2 text-[13px] text-ink-soft">
              <Spinner className="h-4 w-4" /> Loading service profiles…
            </div>
          ) : adaptersError ? (
            <Alert tone="danger" title="Could not load service profiles">
              {adaptersError}
            </Alert>
          ) : adapters.length === 0 ? (
            <EmptyState
              icon={<Layers className="h-5 w-5" />}
              title="No service profiles are registered"
              description="The backend returned no registered product adapters."
            />
          ) : (
            <fieldset>
              <legend className="sr-only">Choose a service profile</legend>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {adapters.map((adapter) => {
                  const isSelected = adapter.id === selected;
                  return (
                    <label
                      key={adapter.id}
                      className={cn(
                        "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                        isSelected
                          ? "border-brand/60 bg-brand-tint"
                          : "border-line bg-surface-2/50 hover:border-line-strong"
                      )}
                    >
                      <input
                        type="radio"
                        name="service-profile"
                        value={adapter.id}
                        checked={isSelected}
                        onChange={() => setSelected(adapter.id)}
                        className="sr-only"
                      />
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                          isSelected ? "border-brand bg-brand" : "border-line-strong"
                        )}
                        aria-hidden="true"
                      >
                        {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="text-[13.5px] font-semibold text-ink">{adapter.name}</span>
                          <Badge tone="neutral">{adapter.toolsCount} tools</Badge>
                        </span>
                        <span className="mt-1 block text-[13px] text-ink-soft">{adapter.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      </Card>


      {/* Step 2 — create session & share invitation */}
      <Card>
        <CardHeader
          title="2. Create the session and invite your prospect"
          description="The backend issues a session plus a single-session invitation token scoped to the prospect."
          icon={<PhoneCall className="h-4 w-4" />}
        />
        <div className="space-y-5 px-5 py-5">
          {error && (
            <Alert tone="danger" title="Session creation failed">
              {error}
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13px] text-ink-soft">
              Selected service:{" "}
              <span className="font-medium text-ink">
                {selectedAdapter ? selectedAdapter.name : "None selected"}
              </span>
            </div>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={starting}
              disabled={!selected}
            >
              <PhoneCall className="h-4 w-4" />
              {starting ? "Creating session…" : "Create session & generate invitation"}
            </Button>
          </div>

          {activeSession && activeSession.status !== "ended" ? (
            <div className="space-y-4 rounded-xl border border-line bg-surface-2/40 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone="positive">
                  <StatusDot tone="positive" pulse /> Session ready
                </Badge>
                <IdText className="text-ink-soft">{activeSession.sessionId}</IdText>
              </div>

              <div className="flex items-center gap-2 text-[13px] text-ink-soft">
                <StatusDot tone="warn" />
                Waiting for the prospect to join — connection status is confirmed in the Live Sales Room.
              </div>

              {activeSession.inviteUrl ? (
                <InviteLinkPanel
                  inviteUrl={activeSession.inviteUrl}
                  sessionId={activeSession.sessionId}
                  onOpenRoom={() => onNavigate("live-room")}
                />
              ) : (
                <Alert tone="warn" title="Invitation link unavailable">
                  This session has no invitation token. Create a new session to generate a fresh link.
                </Alert>
              )}

              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                <Button variant="primary" onClick={() => onNavigate("live-room")}>
                  <Radio className="h-4 w-4" />
                  Open Live Sales Room
                </Button>
                <Button variant="ghost" onClick={() => onNavigate("history")}>
                  View call history
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line px-5 py-8 text-center text-[13px] text-ink-mute">
              No active session yet. Select a service profile and create a session to generate an invitation link.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

