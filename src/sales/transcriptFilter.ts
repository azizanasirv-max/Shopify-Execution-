/**
 * Live-transcript filtering for the salesperson's room.
 *
 * The LiveKit Agent publishes transcription segments attributed to the SPEAKER's
 * participant identity. Two delivery mechanisms exist in the installed SDKs:
 *
 *  1. Legacy signal (`RoomEvent.TranscriptionReceived`, `publishTranscription`).
 *     `livekit-client` 2.22.x surfaces ONLY this one.
 *  2. Transcription text streams on the `lk.transcription` topic
 *     (`localParticipant.streamText`), which the Agents SDK also writes and which
 *     newer `livekit-client` builds consume.
 *
 * Both are filtered by the same rules below: only the prospect's FINAL segments
 * may be forwarded to the Worker's approval gate. The salesperson's own speech
 * (and any agent/unknown identity) must never trigger a recommendation, and
 * interim (partial) segments are not actionable.
 *
 * The Worker always issues the prospect identity as exactly "prospect"
 * (worker.ts -> POST /api/livekit/invite-token); the salesperson is
 * "salesperson". "prospect_*" is accepted for scoped variants. The same
 * identity constant is pinned on the agent side
 * (`agent/agent.ts` -> `inputOptions.participantIdentity`).
 *
 * Extracted from LiveKitSalesRoom.tsx so the filtering rules are unit-testable
 * without rendering the component.
 */

/** The prospect's fixed LiveKit identity (mirrors worker.ts + agent/agent.ts). */
export const PROSPECT_IDENTITY = "prospect";
/** Prefix accepted for scoped prospect identities (e.g. "prospect_abc123"). */
export const PROSPECT_IDENTITY_PREFIX = "prospect_";

/** Topic the Agents SDK uses for transcription text streams. */
export const TRANSCRIPTION_STREAM_TOPIC = "lk.transcription";
/** Stream attribute set to "true" on the final chunk of a transcript segment. */
export const TRANSCRIPTION_ATTR_FINAL = "lk.transcription_final";
/** Stream attribute carrying the provider segment id. */
export const TRANSCRIPTION_ATTR_SEGMENT_ID = "lk.transcription_segment_id";

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

/* -------------------------------------------------------------------------- */
/* Transcription text streams (`lk.transcription`)                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal shape of the stream metadata handed to a LiveKit text-stream handler
 * (`TextStreamInfo`) plus the `participantInfo` argument's identity.
 */
export interface TranscriptionStreamInfo {
  topic?: string;
  senderIdentity?: string;
  attributes?: Record<string, string>;
}

/**
 * True when the stream is a transcription stream whose FINAL marker is set.
 *
 * SECURITY: the sender identity is matched against the prospect ONLY (never the
 * agent, the salesperson, or an empty/unknown identity), so an agent-authored or
 * salesperson-authored stream can never be mistaken for prospect speech.
 */
export function shouldForwardTranscriptionStream(
  info: TranscriptionStreamInfo | null | undefined
): boolean {
  if (!info) return false;
  if (info.topic !== TRANSCRIPTION_STREAM_TOPIC) return false;
  if (!isProspectIdentity(info.senderIdentity)) return false;
  return info.attributes?.[TRANSCRIPTION_ATTR_FINAL] === "true";
}

/**
 * Stable segment id for a transcription stream, used to de-duplicate against the
 * legacy `RoomEvent.TranscriptionReceived` delivery of the same segment (the
 * Agents SDK emits both and uses one shared id for the segment).
 */
export function transcriptionStreamSegmentId(
  info: TranscriptionStreamInfo | null | undefined
): string | undefined {
  const id = info?.attributes?.[TRANSCRIPTION_ATTR_SEGMENT_ID];
  return id && id.trim() ? id : undefined;
}

/* -------------------------------------------------------------------------- */
/* Transcription health (so an empty panel is never silently ambiguous)       */
/* -------------------------------------------------------------------------- */

/** How long a connected prospect may be silent before the UI says so. */
export const TRANSCRIPTION_STALL_MS = 15000;

export type TranscriptionHealth = "idle" | "waiting" | "stalled" | "receiving" | "error";

export interface TranscriptionHealthInput {
  /** A LiveKit room connection is established. */
  connected: boolean;
  /** The prospect participant is present in the room. */
  prospectPresent: boolean;
  /** Number of FINAL prospect segments received so far this call. */
  segmentCount: number;
  /** Milliseconds since the prospect joined (or since connect when unknown). */
  sinceProspectMs: number;
  /** A LiveKit/agent error was observed. */
  hasError: boolean;
}

/**
 * Pure health reducer for the transcript panel. It only ever downgrades the
 * message: it never changes which segments are accepted.
 */
export function transcriptionHealth(input: TranscriptionHealthInput): TranscriptionHealth {
  if (input.hasError) return "error";
  if (!input.connected || !input.prospectPresent) return "idle";
  if (input.segmentCount > 0) return "receiving";
  return input.sinceProspectMs >= TRANSCRIPTION_STALL_MS ? "stalled" : "waiting";
}
