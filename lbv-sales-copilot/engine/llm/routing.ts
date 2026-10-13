/**
 * Deterministic routing + concise-output constraints.
 *
 * Goal: cut latency and unnecessary model calls during a live sales
 * conversation. Purely deterministic (no model call) decisions filter out
 * utterances that cannot yield an actionable next line, and every generated
 * recommendation is constrained to a short, speakable length.
 */

export interface RoutingDecision {
  /** Whether the model should be invoked for this utterance. */
  invokeModel: boolean;
  /** Machine-readable reason (for telemetry/tests). */
  reason: string;
}

export interface RoutingOptions {
  /** Minimum number of words for an utterance to be considered actionable. */
  minWords?: number;
  /** Max utterance length considered (chars); longer text is always actionable. */
  fillerMaxChars?: number;
  /** Known non-actionable backchannel / acknowledgement phrases. */
  backchannels?: string[];
}

const DEFAULT_BACKCHANNELS = [
  "mm hmm",
  "mm-hmm",
  "mhm",
  "uh huh",
  "uh-huh",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "right",
  "sure",
  "alright",
  "hello",
  "hi",
  "hey",
  "thanks",
  "thank you",
  "cool",
  "got it",
  "i see"
];

/** Normalizes an utterance for deterministic comparison. */
export function normalizeUtterance(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(normalized: string): number {
  return normalized ? normalized.split(" ").filter(Boolean).length : 0;
}

/**
 * Deterministically decides whether a prospect utterance warrants an LLM call.
 * Non-actionable backchannels, empty text, and sub-threshold filler are skipped.
 */
export function decideRouting(text: string, options: RoutingOptions = {}): RoutingDecision {
  const minWords = options.minWords ?? 2;
  const fillerMaxChars = options.fillerMaxChars ?? 24;
  const backchannels = options.backchannels ?? DEFAULT_BACKCHANNELS;

  const normalized = normalizeUtterance(text);

  if (!normalized) {
    return { invokeModel: false, reason: "empty" };
  }

  if (normalized.length <= fillerMaxChars && backchannels.includes(normalized)) {
    return { invokeModel: false, reason: "backchannel" };
  }

  if (wordCount(normalized) < minWords && normalized.length <= fillerMaxChars) {
    return { invokeModel: false, reason: "too_short" };
  }

  return { invokeModel: true, reason: "actionable" };
}

/**
 * Detects whether `text` duplicates the most recent utterance (idempotency /
 * stale transcript suppression). Deterministic and side-effect free.
 */
export function isDuplicateUtterance(text: string, recentUtterances: string[]): boolean {
  const normalized = normalizeUtterance(text);
  if (!normalized) return false;
  return recentUtterances.some((prev) => normalizeUtterance(prev) === normalized);
}

export interface ConciseDirectiveOptions {
  minWords?: number;
  maxWords?: number;
}

/**
 * Appends an explicit brevity constraint to a system instruction so that model
 * output stays within the target range (default 15-35 words) and remains
 * speakable during a live call.
 */
export function withConciseDirective(systemInstruction: string, options: ConciseDirectiveOptions = {}): string {
  const minWords = options.minWords ?? 15;
  const maxWords = options.maxWords ?? 35;
  const directive =
    `\n\nOUTPUT CONSTRAINT: Respond with a single, immediately speakable line for the salesperson ` +
    `between ${minWords} and ${maxWords} words. No preamble, no bullet points, no meta-commentary. ` +
    `Never exceed ${maxWords} words.`;
  const base = systemInstruction || "";
  if (base.includes("OUTPUT CONSTRAINT:")) return base;
  return base + directive;
}

/** Word count helper exposed for validation/tests. */
export function countWords(text: string): number {
  const normalized = normalizeUtterance(text);
  return wordCount(normalized);
}
