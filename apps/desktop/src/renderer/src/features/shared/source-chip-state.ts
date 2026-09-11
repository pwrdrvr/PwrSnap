// Mapping from "what the monitor observed" to "what the chip says".
//
// This is deliberately its own module rather than a method on either
// side. `useMicrophoneMonitor` reports facts about a device;
// `SourceChip` renders a presentation state; neither should have to
// know about the other to be tested. The translation between them is
// the part with actual judgement in it, so it lives alone and is
// pinned by its own tests.

import type { SourceChipState } from "./SourceChip";
import type { MicFault, MicPermission } from "./useMicrophoneMonitor";

export type MicrophoneChipInput = {
  /** Armed for this take — the user's on/off choice. */
  readonly on: boolean;
  /**
   * Whether a stream has actually been attempted yet.
   *
   * A Quick Capture that merely OFFERS Record shows the chips without
   * opening the microphone, so `permission` is still the initial
   * `"prompt"` and means nothing. Reporting `ask` there would put an
   * "Allow" button in front of a user who may well already have
   * granted access — and who is probably about to take a screenshot.
   *
   * An armed-off chip is `live` with the meter suppressed
   * (`noMeter`): "this take will record the microphone" is known and
   * true; "and a signal is arriving" is not yet knowable.
   */
  readonly armed: boolean;
  readonly permission: MicPermission;
  readonly fault: MicFault;
  readonly silent: boolean;
};

/**
 * Resolve the microphone chip's state.
 *
 * Order matters. Each branch answers "what is the user's next action?",
 * and the earlier branches are the ones where that action is NOT
 * "carry on":
 *
 *   unsupported  nothing to do, and never will be
 *   off          the user switched it off; say nothing else
 *   nodevice     plug something in
 *   denied       open System Settings
 *   ask          click Allow
 *   silent       check the input — it is open and hearing nothing
 *   live         carry on
 *
 * `off` sits above the fault states on purpose: a chip the user turned
 * off must not nag about a microphone that is missing or blocked. It
 * is not going to be recorded either way.
 */
export function microphoneChipState({
  on,
  armed,
  permission,
  fault,
  silent
}: MicrophoneChipInput): SourceChipState {
  if (permission === "unsupported") return "unsupported";
  if (!on) return "off";
  // Nothing has been opened, so nothing is known beyond the user's own
  // choice. Report exactly that: on, with no claim about signal.
  if (!armed) return "live";
  if (fault === "nodevice") return "nodevice";
  if (permission === "denied") return "denied";
  if (permission === "prompt") return "ask";
  // `busy` and `unknown` both leave the device unopened with the grant
  // intact. There is no button that fixes either one, so the chip
  // reports it as armed-but-not-arriving and lets `why` carry the
  // sentence — the same shape a genuinely silent microphone gets.
  if (fault !== "none") return "silent";
  return silent ? "silent" : "live";
}

/**
 * The microphone chip's `why` line — the short reason shown next to the
 * meter. `null` when there is nothing worth saying.
 */
export function microphoneChipWhy(
  state: SourceChipState,
  error: string | null
): string | undefined {
  switch (state) {
    case "ask":
      return "needs access";
    case "denied":
      return "blocked";
    case "nodevice":
      return "no microphone";
    case "unsupported":
      return "unavailable";
    case "silent":
      // A device held by another app is a different problem from a
      // muted one, and only the monitor knows which happened.
      return error ?? "no signal";
    default:
      return undefined;
  }
}
