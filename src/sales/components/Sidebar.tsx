import React from "react";
import { X, AudioLines } from "lucide-react";
import { NAV_ITEMS } from "../nav";
import { DashboardRoute } from "../useHashRoute";
import { cn, StatusDot } from "./ui";

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-brand/40 bg-brand-tint text-brand">
        <AudioLines className="h-4.5 w-4.5" strokeWidth={2.2} />
      </div>
      {!compact && (
        <div className="leading-tight">
          <p className="text-[13px] font-semibold tracking-tight text-ink">LBV Sales Copilot</p>
          <p className="text-[11px] text-ink-mute">Live sales workspace</p>
        </div>
      )}
    </div>
  );
}

export interface SidebarProps {
  route: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
  liveKitConfigured?: boolean | null;
  activeCall?: boolean;
  /** Rendered inside the mobile drawer: shows a close button. */
  onClose?: () => void;
}

export function SidebarNav({
  route,
  onNavigate,
  liveKitConfigured,
  activeCall = false,
  onClose,
}: SidebarProps) {
  return (
    <div className="flex h-full flex-col bg-surface/95">
      <div className="flex items-center justify-between px-4 py-4">
        <BrandMark />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-lg border border-line p-1.5 text-ink-soft hover:text-ink hover:bg-surface-2 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2.5 py-2">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = route === item.route;
            return (
              <li key={item.route}>
                <button
                  type="button"
                  onClick={() => onNavigate(item.route)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors cursor-pointer",
                    active
                      ? "bg-brand-tint text-ink border border-brand/30"
                      : "text-ink-soft hover:bg-surface-2 hover:text-ink border border-transparent"
                  )}
                >
                  <Icon
                    className={cn("h-4 w-4 shrink-0", active ? "text-brand" : "text-ink-mute group-hover:text-ink-soft")}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-medium">{item.label}</span>
                  </span>
                  {item.route === "live-room" && activeCall && (
                    <StatusDot tone="positive" pulse className="ml-auto" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line px-4 py-3.5">
        <div className="flex items-center gap-2 text-[12px]">
          <StatusDot
            tone={liveKitConfigured === null ? "neutral" : liveKitConfigured ? "positive" : "warn"}
          />
          <span className="text-ink-soft">
            {liveKitConfigured === null
              ? "Checking LiveKit…"
              : liveKitConfigured
                ? "LiveKit Cloud connected"
                : "LiveKit not configured"}
          </span>
        </div>
        {activeCall && (
          <p className="mt-2 text-[11px] text-positive">A sales session is in progress.</p>
        )}
      </div>
    </div>
  );
}
