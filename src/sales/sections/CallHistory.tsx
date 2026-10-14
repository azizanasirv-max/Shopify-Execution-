import { useState } from "react";
import { History, PhoneCall, Radio, RefreshCw, Trash2, Info } from "lucide-react";
import { useSession } from "../SessionContext";
import { useAdapters } from "../useAdapters";
import { DashboardRoute } from "../useHashRoute";
import { getSessionSummary } from "../api";
import { Alert, Badge, Button, Card, EmptyState, IdText, SectionHeader, StatusDot } from "../components/ui";

interface SessionDetail {
  lastActivityAt: number;
  historyCount: number;
}

function formatTime(ts?: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

const STATUS_TONE = { created: "warn", live: "positive", ended: "neutral" } as const;

export function CallHistory({ onNavigate }: { onNavigate: (r: DashboardRoute) => void }) {
  const { calls, getSessionToken, activateCall, removeCall, clearHistory, setStatus } = useSession();
  const { nameFor } = useAdapters();
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (sessionId: string) => {
    const token = getSessionToken(sessionId);
    if (!token) {
      setError("This session's authorization token is no longer in memory. Create a new session to continue.");
      return;
    }
    setRefreshingId(sessionId);
    setError(null);
    try {
      const data = await getSessionSummary(sessionId, token);
      const summary = data.sessions?.[0];
      if (summary) {
        setDetails((prev) => ({
          ...prev,
          [sessionId]: { lastActivityAt: summary.lastActivityAt, historyCount: summary.historyCount },
        }));
        setStatus(sessionId, summary.lastActivityAt > summary.createdAt ? "live" : "created");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh this session.");
    } finally {
      setRefreshingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Call History"
        description="Sessions created in this browser tab during the current visit."
        actions={
          calls.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={clearHistory}>
              <Trash2 className="h-3.5 w-3.5" /> Clear list
            </Button>
          ) : undefined
        }
      />

      <Alert tone="neutral" title="Scope of this history" icon={<Info className="h-4 w-4" />}>
        Sessions are tracked in memory for this tab only. The Worker intentionally blocks global session listing
        across salespeople, so no persistent cross-device history endpoint exists yet.
      </Alert>

      {error && <Alert tone="danger" title="Action failed">{error}</Alert>}

      {calls.length === 0 ? (
        <Card>
          <EmptyState
            icon={<History className="h-5 w-5" />}
            title="No sessions yet"
            description="Sessions you create in this browser will appear here with their identifiers and status."
            action={
              <Button variant="primary" onClick={() => onNavigate("new-call")}>
                <PhoneCall className="h-4 w-4" />
                New sales call
              </Button>
            }
          />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {calls.map((call) => {
              const detail = details[call.sessionId];
              const isActive = call.status !== "ended";
              return (
                <li
                  key={call.sessionId}
                  className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATUS_TONE[call.status]}>
                        <StatusDot tone={STATUS_TONE[call.status]} pulse={call.status === "live"} />
                        {call.status === "created" ? "Created" : call.status === "live" ? "In progress" : "Ended"}
                      </Badge>
                      <span className="text-[13px] font-medium text-ink">{nameFor(call.productId)}</span>
                    </div>
                    <div className="mt-1.5">
                      <IdText className="text-ink-soft">{call.sessionId}</IdText>
                    </div>
                    <p className="mt-1 text-[12px] text-ink-mute">
                      Created {formatTime(call.createdAt)}
                      {detail
                        ? ` · Last activity ${formatTime(detail.lastActivityAt)} · ${detail.historyCount} turns`
                        : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void refresh(call.sessionId)}
                      loading={refreshingId === call.sessionId}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Status
                    </Button>
                    {isActive && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          activateCall(call.sessionId);
                          onNavigate("live-room");
                        }}
                      >
                        <Radio className="h-3.5 w-3.5" /> Open room
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => removeCall(call.sessionId)}>
                      <Trash2 className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

