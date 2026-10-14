import {
  LayoutDashboard,
  PhoneCall,
  Radio,
  History,
  Layers,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { DashboardRoute } from "./useHashRoute";

export interface NavItem {
  route: DashboardRoute;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  {
    route: "dashboard",
    label: "Dashboard",
    description: "Overview and active session",
    icon: LayoutDashboard,
  },
  {
    route: "new-call",
    label: "New Sales Call",
    description: "Create a session and invite a prospect",
    icon: PhoneCall,
  },
  {
    route: "live-room",
    label: "Live Sales Room",
    description: "Run the call with live AI guidance",
    icon: Radio,
  },
  {
    route: "history",
    label: "Call History",
    description: "Sessions created in this browser",
    icon: History,
  },
  {
    route: "profiles",
    label: "Service Profiles",
    description: "Offers, audiences and playbooks",
    icon: Layers,
  },
  {
    route: "settings",
    label: "Settings",
    description: "Preferences and runtime status",
    icon: Settings,
  },
];
