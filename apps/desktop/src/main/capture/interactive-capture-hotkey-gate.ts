import { performance } from "node:perf_hooks";

/** Long enough to absorb Windows' duplicate callback burst after one chord. */
export const INTERACTIVE_CAPTURE_HOTKEY_DEBOUNCE_MS = 750;

export type InteractiveCaptureHotkeyDecision =
  | Readonly<{
      status: "accepted";
      reason: "leading_edge";
      ageMs: number | null;
      completion: Promise<void>;
    }>
  | Readonly<{
      status: "suppressed";
      reason: "active" | "debounce";
      ageMs: number;
    }>;

type InteractiveCaptureHotkeyGateOptions = Readonly<{
  now?: () => number;
  debounceMs?: number;
}>;

/**
 * Leading-edge gate for selector-based global shortcuts.
 *
 * `tryStart()` claims the shared slot synchronously, before `task` can create
 * a capture invocation or dispatch any IPC. The active slot covers the full
 * picker lifecycle. The short trailing debounce also absorbs duplicate native
 * callbacks when an attempt exits before Windows finishes delivering one
 * physical chord's events.
 */
export function createInteractiveCaptureHotkeyGate(
  options: InteractiveCaptureHotkeyGateOptions = {}
): Readonly<{
  tryStart(task: () => Promise<void>): InteractiveCaptureHotkeyDecision;
}> {
  const now = options.now ?? (() => performance.now());
  const debounceMs =
    options.debounceMs ?? INTERACTIVE_CAPTURE_HOTKEY_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError(
      "interactive capture hotkey debounce must be a finite non-negative number"
    );
  }

  let sequence = 0;
  let activeSequence: number | null = null;
  let activeStartedAtMs = 0;
  let lastAcceptedAtMs: number | null = null;

  const elapsedSince = (observedAtMs: number, startedAtMs: number): number =>
    Math.max(0, observedAtMs - startedAtMs);

  return {
    tryStart(task): InteractiveCaptureHotkeyDecision {
      const observedAtMs = now();
      if (activeSequence !== null) {
        return {
          status: "suppressed",
          reason: "active",
          ageMs: elapsedSince(observedAtMs, activeStartedAtMs)
        };
      }

      const ageMs =
        lastAcceptedAtMs === null
          ? null
          : elapsedSince(observedAtMs, lastAcceptedAtMs);
      if (ageMs !== null && ageMs < debounceMs) {
        return { status: "suppressed", reason: "debounce", ageMs };
      }

      const ownSequence = ++sequence;
      activeSequence = ownSequence;
      activeStartedAtMs = observedAtMs;
      lastAcceptedAtMs = observedAtMs;
      const completion = Promise.resolve()
        .then(task)
        .finally(() => {
          if (activeSequence === ownSequence) activeSequence = null;
        });
      return {
        status: "accepted",
        reason: "leading_edge",
        ageMs,
        completion
      };
    }
  };
}
