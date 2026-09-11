// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { describeMicError, segmentsForRms } from "../useMicrophoneMonitor";

describe("segmentsForRms", () => {
  test("silence lights nothing", () => {
    expect(segmentsForRms(0)).toBe(0);
  });

  // The reason the full-scale reference is 0.35 and not 1.0: speech at a
  // normal distance is a small RMS, and mapping 1.0 to full scale would
  // leave a perfectly good microphone showing a single segment — which
  // reads as "barely working" for the most common case there is.
  test("conversational speech lands mid-meter, not at one segment", () => {
    expect(segmentsForRms(0.05)).toBeGreaterThanOrEqual(1);
    expect(segmentsForRms(0.15)).toBeGreaterThanOrEqual(3);
    expect(segmentsForRms(0.15)).toBeLessThanOrEqual(4);
  });

  test("loud input reaches the warm top segments", () => {
    expect(segmentsForRms(0.32)).toBeGreaterThanOrEqual(6);
  });

  test("clamps rather than overflowing the meter", () => {
    expect(segmentsForRms(4)).toBe(7);
    expect(segmentsForRms(-1)).toBe(0);
  });

  test("is monotonic", () => {
    let previous = -1;
    for (let rms = 0; rms <= 0.5; rms += 0.01) {
      const next = segmentsForRms(rms);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });
});

describe("describeMicError", () => {
  function err(name: string): Error {
    const e = new Error(name);
    e.name = name;
    return e;
  }

  // A denial and a device that is merely busy need different words and
  // lead to different remedies; collapsing them into "mic failed" is
  // what sends a user to System Settings to fix a Zoom call.
  test("a refusal reads as denied", () => {
    expect(describeMicError(err("NotAllowedError"))).toEqual({
      permission: "denied",
      fault: "denied",
      message: "Microphone access is blocked"
    });
  });

  test("a missing device is granted-but-absent, not denied", () => {
    const described = describeMicError(err("NotFoundError"));
    expect(described.permission).toBe("granted");
    expect(described.fault).toBe("nodevice");
    expect(described.message).toBe("No microphone found");
  });

  test("a device held by another app says so", () => {
    const described = describeMicError(err("NotReadableError"));
    expect(described.permission).toBe("granted");
    expect(described.fault).toBe("busy");
    expect(described.message).toContain("another app");
  });

  test("an unknown failure does not claim a permission state", () => {
    expect(describeMicError(err("WeirdError")).permission).toBe("prompt");
    expect(describeMicError(null).permission).toBe("prompt");
  });

  // `fault` is what the chip branches on; `message` is what the human
  // reads. A Chromium release that rewords a message must not be able
  // to change which button the chip offers.
  test("every fault is a value, never a parsed sentence", () => {
    const faults = ["NotAllowedError", "NotFoundError", "NotReadableError", "WeirdError"].map(
      (name) => describeMicError(err(name)).fault
    );
    expect(faults).toEqual(["denied", "nodevice", "busy", "unknown"]);
  });
});
