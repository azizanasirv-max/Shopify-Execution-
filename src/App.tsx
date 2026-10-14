/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import ProspectCall from "../lbv-sales-copilot/app/ProspectCall";
import { SessionProvider } from "./sales/SessionContext";
import { SalesDashboard } from "./sales/SalesDashboard";
import { isProspectRoute } from "./sales/invite";

/**
 * Top-level routing.
 *
 * - A prospect invitation link (`?join=1&sessionId=...&token=...`) renders ONLY
 *   the prospect audio-only call interface. The salesperson dashboard is never
 *   rendered for a prospect, so recommendations, transcripts, and provider
 *   details cannot leak into the prospect experience.
 * - Every other route renders the salesperson dashboard.
 */
export default function App() {
  const isProspect = typeof window !== "undefined" && isProspectRoute(window.location.search);

  if (isProspect) {
    return <ProspectCall />;
  }

  return (
    <SessionProvider>
      <SalesDashboard />
    </SessionProvider>
  );
}
