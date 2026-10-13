/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import Page from "../lbv-sales-copilot/app/page";
import ProspectCall from "../lbv-sales-copilot/app/ProspectCall";

/**
 * Top-level routing.
 *
 * An invitation link (?join=1&sessionId=...&token=...) renders ONLY the
 * prospect audio-only call interface. The salesperson dashboard (Page) is never
 * rendered for a prospect, so recommendations, internal notes, and provider
 * details cannot leak into the prospect experience.
 */
export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isProspectJoin =
    params.get("join") === "1" ||
    params.get("prospect") === "1" ||
    (typeof window !== "undefined" && window.sessionStorage.getItem("lbv_is_prospect") === "1");

  if (isProspectJoin) {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem("lbv_is_prospect", "1");
    }
    return <ProspectCall />;
  }

  return <Page />;
}
