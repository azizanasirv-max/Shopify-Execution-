/**
 * Live-transcript filtering for the salesperson's room.
 *
 * The LiveKit Agent publishes transcription segments attributed to the SPEAKER's
 * participant identity (`RoomEvent.TranscriptionReceived`). Only the prospect's
 * FINAL segments may be forwarded to the Worker's approval gate: the
 * salesperson's own speech must never trigger a recommendation, and interim
 * (partial) segments are not actionable.
 *
 * The Worker always issues the prospect identity as exactly "prospect"
 * (worker.ts -> POST /api/livekit/invite-token); the salesperson is
 * "salesperson". "prospect_*" is accepted for scoped variants. The same
 * identity constant is pinned on the agent side
 * (`agent/agent.ts` -> `inputOptions.participantIdentity`).
 *
 * Extracted from LiveKitSalesRoom.tsx so the filtering rules are unit-testable
 * without rendering the component. Behaviour is unchanged.
 */

/** The prospect's fixed LiveKit identity (mirrors worker.ts + agent/agent.ts). */
export const PROSPECT_IDENTITY = "prospect";
/** Prefix accepted for scoped prospect identities (e.g. "prospect_abc123"). */
export const PROSPECT_IDENTITY_PREFIX = "prospect_";

/** True when the identity belongs to the prospect (case-insensitive). */
export function isProspectIdentity(identity: unknown): boolean {
  if (typeof identity !== "string") return false;
  const lower = identity.toLowerCase();
  return lower === PROSPECT_IDENTITY || lower.startsWith(PROSPECT_IDENTITY_PREFIX);
}

/**
 * Minimal shape of a transcription segment as delivered by livekit-client
 * (`TranscriptionSegment`) plus the aliases older agent builds emitted.
 */
export interface RawTranscriptionSegment {
  id?: string;
  segmentId?: string;
  isFinal?: boolean;
  final?: boolean;
  text?: string;
  transcript?: string;
  participantIdentity?: string;
}

/** Segment text, tolerating both `text` and the legacy `transcript` field. */
export function segmentText(segment: RawTranscriptionSegment | null | undefined): string {
  if (!segment) return "";
  const text = segment.text || segment.transcript || "";
  return typeof text === "string" ? text : "";
}

/** True when the segment is flagged final (either field name). */
export function isFinalSegment(segment: RawTranscriptionSegment | null | undefined): boolean {
  return segment?.isFinal === true || segment?.final === true;
}

/**
 * True only for a FINAL, non-empty segment spoken by the prospect.
 *
 * `participantIdentity` is the identity from the event's participant argument;
 * it takes precedence over the segment's own `participantIdentity` field, which
 * matches the original inline implementation.
 */
export function shouldForwardProspectSegment(
  segment: RawTranscriptionSegment | null | undefined,
  participantIdentity?: string | null
): boolean {
  if (!isFinalSegment(segment)) return false;
  if (!segmentText(segment).trim()) return false;
  return isProspectIdentity(participantIdentity || segment?.participantIdentity);
}
