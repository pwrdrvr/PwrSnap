import { describe, expect, test, vi } from "vitest";
import {
  INTERACTIVE_CAPTURE_HOTKEY_DEBOUNCE_MS,
  createInteractiveCaptureHotkeyGate
} from "../interactive-capture-hotkey-gate";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("interactive capture hotkey gate", () => {
  test("one native callback burst starts exactly one capture task", async () => {
    let nowMs = 1_000;
    const pending = deferred();
    const task = vi.fn(() => pending.promise);
    const gate = createInteractiveCaptureHotkeyGate({ now: () => nowMs });

    const first = gate.tryStart(task);
    expect(first).toMatchObject({
      status: "accepted",
      reason: "leading_edge",
      ageMs: null
    });

    nowMs = 1_300;
    expect(gate.tryStart(task)).toEqual({
      status: "suppressed",
      reason: "active",
      ageMs: 300
    });
    nowMs = 1_600;
    expect(gate.tryStart(task)).toEqual({
      status: "suppressed",
      reason: "active",
      ageMs: 600
    });

    await Promise.resolve();
    expect(task).toHaveBeenCalledOnce();
    pending.resolve();
    if (first.status === "accepted") await first.completion;
  });

  test("an active picker suppresses another shortcut beyond the debounce", async () => {
    let nowMs = 2_000;
    const pending = deferred();
    const gate = createInteractiveCaptureHotkeyGate({ now: () => nowMs });
    const first = gate.tryStart(() => pending.promise);

    nowMs += 5_000;
    expect(gate.tryStart(async () => undefined)).toEqual({
      status: "suppressed",
      reason: "active",
      ageMs: 5_000
    });

    pending.resolve();
    if (first.status === "accepted") await first.completion;
    const next = gate.tryStart(async () => undefined);
    expect(next.status).toBe("accepted");
    if (next.status === "accepted") await next.completion;
  });

  test("a fast exit still suppresses the rest of the callback burst", async () => {
    let nowMs = 10_000;
    const task = vi.fn(async () => undefined);
    const gate = createInteractiveCaptureHotkeyGate({ now: () => nowMs });
    const first = gate.tryStart(task);
    if (first.status === "accepted") await first.completion;

    nowMs += INTERACTIVE_CAPTURE_HOTKEY_DEBOUNCE_MS - 1;
    expect(gate.tryStart(task)).toEqual({
      status: "suppressed",
      reason: "debounce",
      ageMs: INTERACTIVE_CAPTURE_HOTKEY_DEBOUNCE_MS - 1
    });

    nowMs += 1;
    const next = gate.tryStart(task);
    expect(next.status).toBe("accepted");
    if (next.status === "accepted") await next.completion;
    expect(task).toHaveBeenCalledTimes(2);
  });

  test("rejects invalid debounce configuration", () => {
    expect(() =>
      createInteractiveCaptureHotkeyGate({ debounceMs: -1 })
    ).toThrow(RangeError);
    expect(() =>
      createInteractiveCaptureHotkeyGate({ debounceMs: Number.NaN })
    ).toThrow(RangeError);
  });
});
