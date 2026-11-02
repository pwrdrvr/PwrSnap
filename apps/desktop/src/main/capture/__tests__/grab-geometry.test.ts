import { describe, expect, test } from "vitest";
import { checkGrabMatchesDisplay, GRAB_ASPECT_TOLERANCE } from "../grab-geometry";

describe("checkGrabMatchesDisplay", () => {
  test("accepts a healthy HiDPI grab — physical pixels, display-logical bounds", () => {
    const verdict = checkGrabMatchesDisplay({
      grab: { width: 2992, height: 1934 },
      bounds: { width: 1496, height: 967 }
    });
    expect(verdict.ok).toBe(true);
  });

  test("accepts a 1x grab", () => {
    expect(
      checkGrabMatchesDisplay({
        grab: { width: 1920, height: 1080 },
        bounds: { width: 1920, height: 1080 }
      }).ok
    ).toBe(true);
  });

  test("accepts a grab that came back SMALLER than requested", () => {
    // thumbnailSize is a maximum and Chromium preserves aspect while
    // scaling into it, so size alone proves nothing — only shape does.
    expect(
      checkGrabMatchesDisplay({
        grab: { width: 1280, height: 720 },
        bounds: { width: 3840, height: 2160 }
      }).ok
    ).toBe(true);
  });

  test("absorbs the pixel rounding a fractional scale factor introduces", () => {
    // 1496 x 967 at scaleFactor 2.629 -> rounded independently per axis.
    const verdict = checkGrabMatchesDisplay({
      grab: { width: Math.round(1496 * 2.629), height: Math.round(967 * 2.629) },
      bounds: { width: 1496, height: 967 }
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.aspectDrift).toBeLessThan(0.001);
  });

  test("rejects a 16:10 grab claimed to be a 16:9 display", () => {
    const verdict = checkGrabMatchesDisplay({
      grab: { width: 1920, height: 1200 },
      bounds: { width: 1920, height: 1080 }
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toContain("1920x1200");
      expect(verdict.message).toContain("something other than this display");
    }
  });

  test("rejects a stitched dual-monitor desktop — the portal's 'Entire screen'", () => {
    expect(
      checkGrabMatchesDisplay({
        grab: { width: 3840, height: 1080 },
        bounds: { width: 1920, height: 1080 }
      }).ok
    ).toBe(false);
  });

  test("rejects a single window handed back by the portal picker", () => {
    expect(
      checkGrabMatchesDisplay({
        grab: { width: 1024, height: 768 },
        bounds: { width: 2560, height: 1080 }
      }).ok
    ).toBe(false);
  });

  test("rejects a portrait grab for a landscape display", () => {
    expect(
      checkGrabMatchesDisplay({
        grab: { width: 1080, height: 1920 },
        bounds: { width: 1920, height: 1080 }
      }).ok
    ).toBe(false);
  });

  test("rejects degenerate dimensions on either side", () => {
    for (const grab of [
      { width: 0, height: 1080 },
      { width: 1920, height: 0 },
      { width: Number.NaN, height: 1080 },
      { width: -1920, height: -1080 }
    ]) {
      expect(checkGrabMatchesDisplay({ grab, bounds: { width: 1920, height: 1080 } }).ok).toBe(
        false
      );
    }
    expect(
      checkGrabMatchesDisplay({
        grab: { width: 1920, height: 1080 },
        bounds: { width: 0, height: 1080 }
      }).ok
    ).toBe(false);
  });

  test("the tolerance is the boundary, and it is generous enough for rounding", () => {
    const bounds = { width: 1920, height: 1080 };
    // Just inside: shrink height so aspect grows by slightly under tolerance.
    const inside = 1080 / (1 + GRAB_ASPECT_TOLERANCE * 0.9);
    expect(checkGrabMatchesDisplay({ grab: { width: 1920, height: inside }, bounds }).ok).toBe(
      true
    );
    const outside = 1080 / (1 + GRAB_ASPECT_TOLERANCE * 1.5);
    expect(checkGrabMatchesDisplay({ grab: { width: 1920, height: outside }, bounds }).ok).toBe(
      false
    );
  });
});
