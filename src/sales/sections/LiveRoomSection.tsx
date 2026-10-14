import { PhoneCall, Radio } from "lucide-react";
import LiveKitSalesRoom from "../../../lbv-sales-copilot/app/LiveKitSalesRoom";
import { useSession } from "../SessionContext";
import { DashboardRoute } from "../useHashRoute";
import { Button, Card, EmptyState, SectionHeader } from "../components/ui";

export function LiveRoomSection({ onNavigate }: { onNavigate: (r: DashboardRoute) => void }) {
  const { activeSession, getSessionToken, setStatus } = useSession();

  if (!activeSession) {
    return (
      <div className="space-y-6">
        <SectionHeader
          title="Live Sales Room"
          description="The live workspace for the active sales session."
        />
        <Card>
          <EmptyState
            icon={<Radio className="h-5 w-5" />}
            title="No active sales session"
            description="Create a session and share the prospect invitation before opening the live room."
            action={
              <Button variant="primary" onClick={() => onNavigate("new-call")}>
                <PhoneCall className="h-4 w-4" />
                New sales call
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const sessionToken = getSessionToken(activeSession.sessionId) ?? null;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Live Sales Room"
        description="Conduct the conversation. Transcript and private AI guidance stay on your side of the call."
      />
      <LiveKitSalesRoom
        sessionId={activeSession.sessionId}
        sessionToken={sessionToken}
        productId={activeSession.productId}
        inviteUrl={activeSession.inviteUrl}
        onJoined={() => setStatus(activeSession.sessionId, "live")}
        onEnded={() => {
          setStatus(activeSession.sessionId, "ended");
          onNavigate("history");
        }}
      />
    </div>
  );
}
