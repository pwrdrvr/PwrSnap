/**
 * Leading-edge gate for interactive capture triggers.
 *
 * `acquire()` is deliberately synchronous: a hotkey callback claims the
 * single active slot before it starts command dispatch (or any other async
 * work). The debounce absorbs key-repeat / near-simultaneous callbacks after
 * a fast completion, while the active token coalesces triggers for the full
 * lifetime of a picker interaction.
 */

export const CAPTURE_TRIGGER_DEBOUNCE_MS = 750;

export type CaptureTriggerToken = Readonly<{
  sequence: number;
}>;

export type CaptureTriggerDecision =
  | {
      status: "accepted";
      reason: "leading_edge";
      /** Milliseconds since the prior accepted trigger; null on first use. */
      ageMs: number | null;
      acceptedAtMs: number;
      token: CaptureTriggerToken;
    }
  | {
      status: "suppressed";
      reason: "active" | "debounce";
      /** Milliseconds since the trigger responsible for suppression. */
      ageMs: number;
      observedAtMs: number;
    };

export type CaptureTriggerGate = {
  acquire: () => CaptureTriggerDecision;
  /**
   * Release only the interaction which owns `token`. A late `finally` from
   * an older interaction must never clear a newer active acquisition.
   */
  release: (token: CaptureTriggerToken) => boolean;
};

export type CaptureTriggerGateOptions = {
  now?: (() => number) | undefined;
  debounceMs?: number | undefined;
};

function elapsedMs(nowMs: number, startedAtMs: number): number {
  // Date.now() can move backwards when the system clock is corrected. Treat
  // that as zero elapsed rather than accidentally bypassing the debounce.
  return Math.max(0, nowMs - startedAtMs);
}

export function createCaptureTriggerGate(
  options: CaptureTriggerGateOptions = {}
): CaptureTriggerGate {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? CAPTURE_TRIGGER_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError("capture trigger debounce must be a finite non-negative number");
  }

  let sequence = 0;
  let active: { token: CaptureTriggerToken; acceptedAtMs: number } | null = null;
  let lastAcceptedAtMs: number | null = null;

  return {
    acquire(): CaptureTriggerDecision {
      const observedAtMs = now();
      if (active !== null) {
        return {
          status: "suppressed",
          reason: "active",
          ageMs: elapsedMs(observedAtMs, active.acceptedAtMs),
          observedAtMs
        };
      }

      const ageMs =
        lastAcceptedAtMs === null ? null : elapsedMs(observedAtMs, lastAcceptedAtMs);
      if (ageMs !== null && ageMs < debounceMs) {
        return {
          status: "suppressed",
          reason: "debounce",
          ageMs,
          observedAtMs
        };
      }

      const token = Object.freeze({ sequence: ++sequence });
      active = { token, acceptedAtMs: observedAtMs };
      lastAcceptedAtMs = observedAtMs;
      return {
        status: "accepted",
        reason: "leading_edge",
        ageMs,
        acceptedAtMs: observedAtMs,
        token
      };
    },

    release(token: CaptureTriggerToken): boolean {
      if (active?.token !== token) return false;
      active = null;
      return true;
    }
  };
}
