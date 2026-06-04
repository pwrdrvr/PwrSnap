// Shared formatter for Codex turn errors. Both the one-shot enrichment
// client (codex-client.ts) and the multi-turn chat client
// (codex-thread-client.ts) receive errors two ways:
//
//   • an `error` notification — { error: TurnError, willRetry, threadId,
//     turnId } — emitted as soon as a turn faults, BEFORE turn/completed.
//   • a `turn/completed` with status=failed — whose `turn.error` MAY be
//     null even when the turn genuinely failed.
//
// The authoritative, human-useful detail rides the `error` notification.
// Historically PwrSnap (and PwrAgnt) logged that notification as an
// "unknown method" and dropped it, so a failed turn surfaced to the user
// as a bare "Failed" with no reason. This helper turns a TurnError into a
// single transcript-ready line so the actual cause reaches the user.
//
// Codex frequently nests a provider error as a JSON blob inside
// `message`, e.g.
//   {"type":"error","error":{"type":"image_generation_user_error",
//    "code":"invalid_value","message":"The model 'gpt-image-2' does not
//    exist.","param":"tools"},"status":400}
// When we can recognize that shape we surface the inner human message;
// otherwise we pass the raw text through untouched.

import type { TurnError } from "@pwrdrvr/codex-app-server-protocol/v2";

const FALLBACK = "Codex returned an error";

/** Render a {@link TurnError} into one human-readable line. Never throws;
 *  always returns a non-empty string so callers can use it directly as a
 *  rejection message / transcript text. */
export function formatCodexTurnError(error: TurnError | null | undefined): string {
  if (!error) return FALLBACK;
  const base = extractMessage(error.message) || FALLBACK;
  const details = error.additionalDetails?.trim();
  if (details && details.length > 0 && !base.includes(details)) {
    return `${base} (${details})`;
  }
  return base;
}

function extractMessage(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  // Best-effort: unwrap a nested provider-error JSON blob. Only attempt a
  // parse when the text actually looks like JSON — a plain message is the
  // common case and must pass through verbatim.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const nested = nestedErrorMessage(JSON.parse(trimmed));
      if (nested) return nested;
    } catch {
      // Not JSON after all — fall through to the raw text.
    }
  }
  return trimmed;
}

function nestedErrorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const obj = value as Record<string, unknown>;
  const err = obj.error;
  if (typeof err === "object" && err !== null) {
    const inner = (err as Record<string, unknown>).message;
    if (typeof inner === "string" && inner.trim().length > 0) {
      return inner.trim();
    }
  }
  if (typeof obj.message === "string" && obj.message.trim().length > 0) {
    return obj.message.trim();
  }
  return "";
}
