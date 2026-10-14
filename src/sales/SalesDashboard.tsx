import { SalesShell } from "./SalesShell";
import { useHashRoute } from "./useHashRoute";
import { useLiveKitStatus } from "./useLiveKitStatus";
import { useSession } from "./SessionContext";
import { DashboardHome } from "./sections/DashboardHome";
import { NewCall } from "./sections/NewCall";
import { LiveRoomSection } from "./sections/LiveRoomSection";
import { CallHistory } from "./sections/CallHistory";
import { ServiceProfiles } from "./sections/ServiceProfiles";
import { Settings } from "./sections/Settings";

/**
 * The salesperson application shell. Renders the persistent sidebar navigation
 * and the section selected by the URL hash. Never rendered for a prospect.
 */
export function SalesDashboard() {
  const [route, navigate] = useHashRoute();
  const { status: liveKit } = useLiveKitStatus();
  const { activeSession } = useSession();

  const activeCall = Boolean(activeSession && activeSession.status !== "ended");

  return (
    <SalesShell
      route={route}
      onNavigate={navigate}
      liveKitConfigured={liveKit === null ? null : liveKit.configured}
      activeCall={activeCall}
    >
      {route === "dashboard" && <DashboardHome onNavigate={navigate} />}
      {route === "new-call" && <NewCall onNavigate={navigate} />}
      {route === "live-room" && <LiveRoomSection onNavigate={navigate} />}
      {route === "history" && <CallHistory onNavigate={navigate} />}
      {route === "profiles" && <ServiceProfiles />}
      {route === "settings" && <Settings />}
    </SalesShell>
  );
}
