import { describe, expect, test } from "vitest";
import {
  CAPTURE_TRIGGER_DEBOUNCE_MS,
  createCaptureTriggerGate,
  type CaptureTriggerToken
} from "../capture/capture-trigger-gate";

describe("capture trigger gate", () => {
  test("accepts the leading edge and reports deterministic timing metadata", () => {
    let nowMs = 10_000;
    const gate = createCaptureTriggerGate({ now: () => nowMs });

    const first = gate.acquire();
    expect(first).toMatchObject({
      status: "accepted",
      reason: "leading_edge",
      ageMs: null,
      acceptedAtMs: 10_000
    });
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted") throw new Error("expected accepted trigger");
    expect(gate.release(first.token)).toBe(true);

    nowMs += CAPTURE_TRIGGER_DEBOUNCE_MS;
    expect(gate.acquire()).toMatchObject({
      status: "accepted",
      reason: "leading_edge",
      ageMs: CAPTURE_TRIGGER_DEBOUNCE_MS,
      acceptedAtMs: 10_750
    });
  });

  test("triple triggers spanning 600ms dispatch exactly once even after a fast completion", () => {
    let nowMs = 1_000;
    let dispatchCount = 0;
    const gate = createCaptureTriggerGate({ now: () => nowMs });

    const trigger = (): CaptureTriggerToken | null => {
      const decision = gate.acquire();
      if (decision.status === "suppressed") return null;
      dispatchCount += 1;
      return decision.token;
    };

    const first = trigger();
    expect(first).not.toBeNull();
    expect(gate.release(first!)).toBe(true);

    nowMs = 1_300;
    expect(trigger()).toBeNull();
    nowMs = 1_600;
    expect(trigger()).toBeNull();

    expect(dispatchCount).toBe(1);
  });

  test("an active interaction suppresses triggers beyond the debounce window", () => {
    let nowMs = 5_000;
    const gate = createCaptureTriggerGate({ now: () => nowMs });
    const first = gate.acquire();
    expect(first.status).toBe("accepted");

    nowMs = 7_000;
    expect(gate.acquire()).toEqual({
      status: "suppressed",
      reason: "active",
      ageMs: 2_000,
      observedAtMs: 7_000
    });
  });

  test("release is token-safe against a stale interaction finally", () => {
    let nowMs = 0;
    const gate = createCaptureTriggerGate({ now: () => nowMs });
    const first = gate.acquire();
    expect(first.status).toBe("accepted");
    if (first.status !== "accepted") throw new Error("expected first trigger");
    expect(gate.release(first.token)).toBe(true);

    nowMs = CAPTURE_TRIGGER_DEBOUNCE_MS;
    const second = gate.acquire();
    expect(second.status).toBe("accepted");
    if (second.status !== "accepted") throw new Error("expected second trigger");

    expect(gate.release(first.token)).toBe(false);
    nowMs += 5_000;
    expect(gate.acquire()).toMatchObject({
      status: "suppressed",
      reason: "active",
      ageMs: 5_000
    });
    expect(gate.release(second.token)).toBe(true);
  });

  test("rejects invalid debounce configuration", () => {
    expect(() => createCaptureTriggerGate({ debounceMs: -1 })).toThrow(RangeError);
    expect(() => createCaptureTriggerGate({ debounceMs: Number.NaN })).toThrow(RangeError);
  });
});
