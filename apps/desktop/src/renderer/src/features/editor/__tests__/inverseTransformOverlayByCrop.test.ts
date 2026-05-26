// Tests for `inverseTransformOverlayByCrop` — the helper that
// re-normalizes an Overlay's coords by the inverse of a crop rect
// so absolute pixel positions are preserved across a v2 crop.
//
// What MUST hold:
//   • An overlay in the kept region stays at its absolute pixel
//     position (i.e. its new-normalized coords map to the same
//     absolute pixel inside the new canvas as the old-normalized
//     coords mapped to inside the old canvas).
//   • An overlay in the cropped-away region ends up with new-
//     normalized coords > 1 in the affected axis (so the canvas
//     clips it at render time).
//   • Identity-rect crops (`{0,0,1,1}`) round-trip unchanged.
//   • CropOverlay itself returns null (the crop is replaced
//     wholesale by the dispatcher).
//   • Degenerate rect (w<=0 or h<=0) returns null.
//   • Each overlay kind transforms the right fields:
//     - arrow: from + to (both points)
//     - rect / highlight / blur: rect.{x, y, w, h}
//     - text / step: point

import { describe, expect, test } from "vitest";
import { inverseTransformOverlayByCrop } from "../useCaptureModel";
import type { Overlay } from "@pwrsnap/shared";

// Common crop rect: keep the left/top 50% × 50% (= quarter the area).
// Coordinate math:
//   old_x = 0.2 → absolute 0.2 × oldW = 0.2W
//   new canvas width = 0.5 × oldW
//   new_x should put the point at the SAME absolute pixel: 0.2W
//   new_x = absolute / newW = 0.2W / 0.5W = 0.4
//   so the formula `new_x = old_x / 0.5` should give 0.4. ✓
const HALF_CROP = { x: 0, y: 0, w: 0.5, h: 0.5 };

describe("inverseTransformOverlayByCrop — overlays in kept region preserve absolute position", () => {
  test("text: point.x=0.2 (inside kept 50%) → new point.x=0.4", () => {
    const text: Overlay = {
      kind: "text",
      point: { x: 0.2, y: 0.3 },
      body: "hi",
      size: "medium",
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(text, HALF_CROP);
    expect(result).not.toBeNull();
    if (result?.kind !== "text") throw new Error("kind preserved");
    expect(result.point.x).toBeCloseTo(0.4, 6);
    expect(result.point.y).toBeCloseTo(0.6, 6);
    expect(result.body).toBe("hi");
  });

  test("arrow: both endpoints transform", () => {
    const arrow: Overlay = {
      kind: "arrow",
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.4, y: 0.4 },
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(arrow, HALF_CROP);
    if (result?.kind !== "arrow") throw new Error("kind preserved");
    expect(result.from.x).toBeCloseTo(0.2, 6);
    expect(result.from.y).toBeCloseTo(0.4, 6);
    expect(result.to.x).toBeCloseTo(0.8, 6);
    expect(result.to.y).toBeCloseTo(0.8, 6);
  });

  test("rect: x/y translate AND w/h scale", () => {
    const rect: Overlay = {
      kind: "rect",
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(rect, HALF_CROP);
    if (result?.kind !== "rect") throw new Error("kind preserved");
    expect(result.rect.x).toBeCloseTo(0.2, 6);
    expect(result.rect.y).toBeCloseTo(0.2, 6);
    expect(result.rect.w).toBeCloseTo(0.4, 6);
    expect(result.rect.h).toBeCloseTo(0.4, 6);
  });

  test("highlight: same transform as rect", () => {
    const hl: Overlay = {
      kind: "highlight",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    };
    const result = inverseTransformOverlayByCrop(hl, HALF_CROP);
    if (result?.kind !== "highlight") throw new Error("kind preserved");
    // A rect that exactly fills the kept region maps to (0,0,1,1) — the
    // entire NEW canvas.
    expect(result.rect.x).toBeCloseTo(0, 6);
    expect(result.rect.y).toBeCloseTo(0, 6);
    expect(result.rect.w).toBeCloseTo(1, 6);
    expect(result.rect.h).toBeCloseTo(1, 6);
  });
});

describe("inverseTransformOverlayByCrop — overlays in cropped-away region land outside [0,1]", () => {
  test("text: point.x=0.95 (right edge) after crop to 60% width → x>1 (gets clipped)", () => {
    // The user's reported bug: text on the right edge stayed visible
    // (slid leftward) after crop instead of being clipped.
    const text: Overlay = {
      kind: "text",
      point: { x: 0.95, y: 0.5 },
      body: "edge",
      size: "small",
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(text, {
      x: 0,
      y: 0,
      w: 0.6,
      h: 1
    });
    if (result?.kind !== "text") throw new Error("kind preserved");
    // 0.95 / 0.6 = 1.5833... — past the right edge of the new canvas.
    expect(result.point.x).toBeGreaterThan(1);
    expect(result.point.x).toBeCloseTo(1.5833, 3);
    expect(result.point.y).toBeCloseTo(0.5, 6);
  });

  test("arrow with one endpoint past the crop boundary clips just that endpoint", () => {
    const arrow: Overlay = {
      kind: "arrow",
      from: { x: 0.1, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(arrow, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    if (result?.kind !== "arrow") throw new Error("kind preserved");
    expect(result.from.x).toBeCloseTo(0.2, 6); // still in canvas
    expect(result.to.x).toBeCloseTo(1.8, 6); // past right edge
  });
});

describe("inverseTransformOverlayByCrop — edge cases", () => {
  test("identity rect {0,0,1,1} round-trips coords unchanged", () => {
    const text: Overlay = {
      kind: "text",
      point: { x: 0.42, y: 0.73 },
      body: "x",
      size: "small",
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(text, {
      x: 0,
      y: 0,
      w: 1,
      h: 1
    });
    if (result?.kind !== "text") throw new Error("kind preserved");
    expect(result.point.x).toBeCloseTo(0.42, 6);
    expect(result.point.y).toBeCloseTo(0.73, 6);
  });

  test("crop overlay returns null (dispatcher replaces it wholesale)", () => {
    const crop: Overlay = {
      kind: "crop",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    };
    const result = inverseTransformOverlayByCrop(crop, HALF_CROP);
    expect(result).toBeNull();
  });

  test("degenerate crop (w=0) returns null instead of dividing by zero", () => {
    const text: Overlay = {
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "x",
      size: "small",
      color: "auto"
    };
    expect(
      inverseTransformOverlayByCrop(text, { x: 0, y: 0, w: 0, h: 0.5 })
    ).toBeNull();
    expect(
      inverseTransformOverlayByCrop(text, { x: 0, y: 0, w: 0.5, h: 0 })
    ).toBeNull();
  });

  test("non-(0,0) crop offsets translate before scaling", () => {
    // Crop the right-half (rect.x = 0.5, w = 0.5). A point at old x=0.6
    // is 0.1 past the crop's left edge → 0.2 in new normalized space.
    const text: Overlay = {
      kind: "text",
      point: { x: 0.6, y: 0.5 },
      body: "x",
      size: "small",
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(text, {
      x: 0.5,
      y: 0,
      w: 0.5,
      h: 1
    });
    if (result?.kind !== "text") throw new Error("kind preserved");
    expect(result.point.x).toBeCloseTo(0.2, 6);
    expect(result.point.y).toBeCloseTo(0.5, 6);
  });
});
