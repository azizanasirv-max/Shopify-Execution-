import React, { useEffect, useState } from "react";
import { Menu, AudioLines } from "lucide-react";
import { SidebarNav } from "./components/Sidebar";
import { DashboardRoute } from "./useHashRoute";
import { cn, StatusDot } from "./components/ui";

export interface SalesShellProps {
  route: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
  liveKitConfigured?: boolean | null;
  activeCall?: boolean;
  children: React.ReactNode;
}

export function SalesShell({
  route,
  onNavigate,
  liveKitConfigured,
  activeCall = false,
  children,
}: SalesShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [route]);

  // Prevent background scroll while the drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const navigate = (next: DashboardRoute) => {
    setDrawerOpen(false);
    onNavigate(next);
  };

  return (
    <div className="flex min-h-full bg-canvas">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-line lg:block">
        <div className="sticky top-0 h-screen">
          <SidebarNav
            route={route}
            onNavigate={navigate}
            liveKitConfigured={liveKitConfigured}
            activeCall={activeCall}
          />
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line shadow-2xl">
            <SidebarNav
              route={route}
              onNavigate={navigate}
              liveKitConfigured={liveKitConfigured}
              activeCall={activeCall}
              onClose={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-canvas/95 px-4 py-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="rounded-lg border border-line p-2 text-ink-soft hover:text-ink hover:bg-surface-2 cursor-pointer"
          >
            <Menu className="h-4.5 w-4.5" />
          </button>
          <div className="flex items-center gap-2">
            <AudioLines className="h-4 w-4 text-brand" />
            <span className="text-[13px] font-semibold text-ink">LBV Sales Copilot</span>
          </div>
          <div className="flex w-9 justify-end">
            {activeCall && <StatusDot tone="positive" pulse />}
          </div>
        </header>

        <main className={cn("mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8")}>
          {children}
        </main>
      </div>
    </div>
  );
}
