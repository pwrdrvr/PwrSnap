// Unit tests for the pure rect-intersection seam used by
// `appWindowsOverlappingRecording` in main/index.ts. The wider helper
// touches `BrowserWindow.getAllWindows()` / `screen.getAllDisplays()`
// and isn't worth mocking out — testing the geometry primitive in
// isolation is enough to lock the behavior that gates the
// "skip activateApp + raise our window" branch.

import { describe, expect, test } from "vitest";
import { rectIntersectsBounds } from "../capture/rect-overlap";

describe("rectIntersectsBounds", () => {
  // BrowserWindow.getBounds() = { x, y, width, height }
  const library = { x: 100, y: 100, width: 800, height: 600 };

  test("returns true when the rect is fully inside the window bounds", () => {
    const rect = { x: 200, y: 200, w: 100, h: 100 };
    expect(rectIntersectsBounds(rect, library)).toBe(true);
  });

  test("returns true when the rect fully contains the window bounds", () => {
    const rect = { x: 0, y: 0, w: 2000, h: 1500 };
    expect(rectIntersectsBounds(rect, library)).toBe(true);
  });

  test("returns true when the rect partially overlaps the window", () => {
    // Rect straddles the right edge of the library window.
    const rect = { x: 800, y: 200, w: 200, h: 200 };
    expect(rectIntersectsBounds(rect, library)).toBe(true);
  });

  test("returns false when the rect is to the left of the window", () => {
    const rect = { x: 0, y: 200, w: 50, h: 50 };
    expect(rectIntersectsBounds(rect, library)).toBe(false);
  });

  test("returns false when the rect is to the right of the window", () => {
    const rect = { x: 1000, y: 200, w: 50, h: 50 };
    expect(rectIntersectsBounds(rect, library)).toBe(false);
  });

  test("returns false when the rect is above the window", () => {
    const rect = { x: 200, y: 0, w: 50, h: 50 };
    expect(rectIntersectsBounds(rect, library)).toBe(false);
  });

  test("returns false when the rect is below the window", () => {
    const rect = { x: 200, y: 800, w: 50, h: 50 };
    expect(rectIntersectsBounds(rect, library)).toBe(false);
  });

  test("returns false when the rect shares only an edge with the window", () => {
    // Edge contact is not overlap — pixel coords are half-open on the
    // right + bottom. `a.x + a.w > b.x` requires strict greater-than.
    const touchingRight = { x: 900, y: 200, w: 50, h: 50 };
    expect(rectIntersectsBounds(touchingRight, library)).toBe(false);

    const touchingBottom = { x: 200, y: 700, w: 50, h: 50 };
    expect(rectIntersectsBounds(touchingBottom, library)).toBe(false);
  });

  test("returns false for a zero-area rect", () => {
    const rect = { x: 200, y: 200, w: 0, h: 0 };
    expect(rectIntersectsBounds(rect, library)).toBe(false);
  });

  test("works with negative-origin display layouts (left-of-primary)", () => {
    // Secondary monitor to the left of the primary at (-1920, 0).
    const secondaryWindow = { x: -1500, y: 200, width: 800, height: 600 };
    const rectOnSecondary = { x: -1000, y: 300, w: 200, h: 200 };
    expect(rectIntersectsBounds(rectOnSecondary, secondaryWindow)).toBe(true);

    const rectOnPrimary = { x: 100, y: 300, w: 200, h: 200 };
    expect(rectIntersectsBounds(rectOnPrimary, secondaryWindow)).toBe(false);
  });
});
