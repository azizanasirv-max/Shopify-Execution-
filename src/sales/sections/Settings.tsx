import { useState } from "react";
import { Check, Layers, Lock, Radio, Server, Trash2 } from "lucide-react";
import { useSession } from "../SessionContext";
import { useAdapters } from "../useAdapters";
import { useLiveKitStatus } from "../useLiveKitStatus";
import { Alert, Badge, Button, Card, CardHeader, Field, IdText, SectionHeader, StatusDot } from "../components/ui";

const PREFERRED_PROFILE_KEY = "lbv.preferredProfile";

function readPreferred(): string {
  try {
    return window.localStorage.getItem(PREFERRED_PROFILE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function Settings() {
  const { adapters } = useAdapters();
  const { activeSession, calls, endActiveSession, clearHistory } = useSession();
  const { status: liveKit } = useLiveKitStatus();
  const [preferred, setPreferred] = useState<string>(() => readPreferred());
  const [saved, setSaved] = useState(false);

  const handleSavePreferred = (value: string) => {
    setPreferred(value);
    try {
      if (value) window.localStorage.setItem(PREFERRED_PROFILE_KEY, value);
      else window.localStorage.removeItem(PREFERRED_PROFILE_KEY);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch {
      /* preference persistence is optional */
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Settings"
        description="Preferences and runtime status. Session and invitation tokens are never stored in the browser."
      />

      <Card>
        <CardHeader
          title="Default service profile"
          description="Pre-selected when you start a new sales call."
          icon={<Layers className="h-4 w-4" />}
        />
        <div className="space-y-4 px-5 py-5">
          <Field label="Service profile" htmlFor="default-profile" hint="Saved locally on this device only (no credentials).">
            <select
              id="default-profile"
              value={preferred}
              onChange={(e) => handleSavePreferred(e.target.value)}
              className="w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-[13px] text-ink focus:border-brand focus:outline-none"
            >
              <option value="">No preference (first available)</option>
              {adapters.map((adapter) => (
                <option key={adapter.id} value={adapter.id}>
                  {adapter.name}
                </option>
              ))}
            </select>
          </Field>
          {saved && (
            <p className="flex items-center gap-1.5 text-[12px] text-positive">
              <Check className="h-3.5 w-3.5" /> Preference saved.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Runtime status"
          description="Values reported by the Worker. Provider credentials stay server-side."
          icon={<Server className="h-4 w-4" />}
        />
        <div className="space-y-4 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] text-ink-soft">
              <Radio className="h-4 w-4 text-ink-mute" /> LiveKit realtime
            </div>
            {liveKit === null ? (
              <Badge tone="neutral">Checking…</Badge>
            ) : liveKit.configured ? (
              <Badge tone="positive">
                <StatusDot tone="positive" /> Configured
              </Badge>
            ) : (
              <Badge tone="warn">
                <StatusDot tone="warn" /> Not configured
              </Badge>
            )}
          </div>
          {liveKit?.serverUrl && (
            <div className="text-[12px] text-ink-mute">
              Server URL: <IdText className="text-ink-soft">{liveKit.serverUrl}</IdText>
            </div>
          )}
          <p className="text-[12px] text-ink-mute">
            The LLM provider (Groq by default, Gemini optional) is configured entirely on the Worker and is never
            exposed to the browser.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Session management"
          description="End the active session or clear the in-memory call list for this tab."
          icon={<Lock className="h-4 w-4" />}
        />
        <div className="space-y-4 px-5 py-5">
          {activeSession ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 p-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">Active session</p>
                <IdText className="text-ink-soft">{activeSession.sessionId}</IdText>
              </div>
              <Button variant="danger" size="sm" onClick={() => void endActiveSession()}>
                End session
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-ink-soft">No active session.</p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-ink-soft">
              {calls.length} session{calls.length === 1 ? "" : "s"} tracked in this tab.
            </p>
            <Button variant="ghost" size="sm" onClick={clearHistory} disabled={calls.length === 0}>
              <Trash2 className="h-3.5 w-3.5" /> Clear call list
            </Button>
          </div>

          <Alert tone="neutral" title="How credentials are handled" role="status">
            Session authorization and invitation tokens live only in this tab's memory. They are never written to
            localStorage, sessionStorage, cookies, or application logs.
          </Alert>
        </div>
      </Card>
    </div>
  );
}
