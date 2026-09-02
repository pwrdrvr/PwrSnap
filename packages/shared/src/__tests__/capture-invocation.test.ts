import { describe, expect, test } from "vitest";
import {
  CAPTURE_INVOCATION_ORIGINS,
  createCaptureInvocation,
  createCaptureInvocationTrigger,
  finalizeCaptureInvocation,
  isCaptureInvocation
} from "../capture-invocation";

describe("capture invocation identity", () => {
  test("samples the trigger before dispatch and clamps a regressing clock", () => {
    const samples = [120.5, 119.25];
    const invocation = createCaptureInvocation({
      id: "trace-12345678",
      origin: "global_hotkey.quick_capture",
      monotonicNow: () => samples.shift() ?? 0,
      wallNow: () => "2026-09-01T12:00:00.000Z"
    });

    expect(invocation).toEqual({
      id: "trace-12345678",
      origin: "global_hotkey.quick_capture",
      triggerMonotonicMs: 120.5,
      dispatchMonotonicMs: 120.5,
      triggerWallTime: "2026-09-01T12:00:00.000Z"
    });
    expect(isCaptureInvocation(invocation)).toBe(true);
  });

  test("separates callback sampling from dispatch sampling", () => {
    const trigger = createCaptureInvocationTrigger({
      id: "trace-split-1234",
      origin: "global_hotkey.window",
      monotonicNow: () => 50,
      wallNow: () => "2026-09-01T12:00:00.000Z"
    });

    const invocation = finalizeCaptureInvocation(trigger, () => 85);

    expect(trigger).not.toHaveProperty("dispatchMonotonicMs");
    expect(invocation).toEqual({
      ...trigger,
      dispatchMonotonicMs: 85
    });
    expect(isCaptureInvocation(invocation)).toBe(true);
  });

  test("accepts every production trigger origin and requires complete monotonic metadata", () => {
    for (const origin of CAPTURE_INVOCATION_ORIGINS) {
      expect(
        isCaptureInvocation({
          id: `trace-${origin}`,
          origin,
          triggerMonotonicMs: 10,
          dispatchMonotonicMs: 11,
          triggerWallTime: "2026-09-01T12:00:00.000Z"
        })
      ).toBe(true);
    }

    expect(isCaptureInvocation({ mode: "auto" })).toBe(false);
    expect(
      isCaptureInvocation({
        id: "trace-invalid",
        origin: "tray.quick_capture",
        triggerMonotonicMs: 12,
        dispatchMonotonicMs: 11,
        triggerWallTime: "2026-09-01T12:00:00.000Z"
      })
    ).toBe(false);
  });
});
