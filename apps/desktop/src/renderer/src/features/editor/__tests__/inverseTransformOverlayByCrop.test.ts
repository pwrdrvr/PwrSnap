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
import { Overlay as OverlaySchema } from "@pwrsnap/shared";
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

describe("inverseTransformOverlayByCrop — overlays in cropped-away region get clamped or deleted (schema requires [0,1])", () => {
  test("text: anchor past new right edge → null (caller deletes layer)", () => {
    // The user's reported bug: text on the right edge survived the
    // crop (slid leftward into the kept region) instead of being
    // clipped. The fix returns null for text/step whose anchor falls
    // outside the new canvas; the dispatcher deletes the layer rather
    // than upserting with out-of-bounds coords (which the
    // NormalizedScalar.max(1) zod constraint would reject).
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
    expect(result).toBeNull();
  });

  test("step: anchor past new bottom edge → null", () => {
    const step: Overlay = { kind: "step", point: { x: 0.5, y: 0.9 }, index: 1 };
    const result = inverseTransformOverlayByCrop(step, {
      x: 0,
      y: 0,
      w: 1,
      h: 0.5
    });
    expect(result).toBeNull();
  });

  test("rect crossing the new right edge → clamped to [0,1]² intersection", () => {
    // Rect starts in the kept region but extends past the crop
    // boundary. Clamp the rect to the canvas-shaped intersection.
    const rect: Overlay = {
      kind: "rect",
      rect: { x: 0.3, y: 0.3, w: 0.6, h: 0.2 },
      color: "auto"
    };
    // Crop to keep left 50%. Transformed rect would be:
    //   x = 0.6, y = 0.3, w = 1.2, h = 0.2
    // Clamped to canvas:
    //   x = 0.6, y = 0.3, w = 0.4 (stops at x=1), h = 0.2
    const result = inverseTransformOverlayByCrop(rect, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    if (result?.kind !== "rect") throw new Error("kind preserved");
    expect(result.rect.x).toBeCloseTo(0.6, 6);
    expect(result.rect.y).toBeCloseTo(0.3, 6);
    expect(result.rect.w).toBeCloseTo(0.4, 6);
    expect(result.rect.h).toBeCloseTo(0.2, 6);
  });

  test("rect entirely outside the new canvas → null", () => {
    const rect: Overlay = {
      kind: "rect",
      rect: { x: 0.8, y: 0.1, w: 0.1, h: 0.1 },
      color: "auto"
    };
    // Crop to keep left 50% — rect (x:0.8-0.9) is entirely outside.
    const result = inverseTransformOverlayByCrop(rect, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    expect(result).toBeNull();
  });

  test("arrow with one endpoint past crop boundary → endpoint clamped to canvas edge", () => {
    const arrow: Overlay = {
      kind: "arrow",
      from: { x: 0.1, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      color: "auto"
    };
    // Crop to keep left 50% — from at 0.2 (kept), to would be at 1.8
    // (past right edge). Endpoints get clamped: to.x = 1.
    const result = inverseTransformOverlayByCrop(arrow, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    if (result?.kind !== "arrow") throw new Error("kind preserved");
    expect(result.from.x).toBeCloseTo(0.2, 6);
    expect(result.from.y).toBeCloseTo(0.5, 6);
    expect(result.to.x).toBeCloseTo(1, 6); // clamped from 1.8
    expect(result.to.y).toBeCloseTo(0.5, 6);
  });

  test("arrow with BOTH endpoints past same edge → null (segment can't cross canvas)", () => {
    const arrow: Overlay = {
      kind: "arrow",
      from: { x: 0.7, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(arrow, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    expect(result).toBeNull();
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

  test("schema invariant: any non-null transform output passes the Overlay schema", () => {
    // The Overlay zod schema's NormalizedScalar refuses values outside
    // [0,1]. So the helper MUST NOT emit out-of-bounds coords — the
    // bus's BundleLayerNode.safeParse at layers:upsert would reject
    // and the dispatcher's `if (!insResult.ok) return err(...)` would
    // bail mid-transform, leaving the overlay at its OLD coords (which
    // IS the bug class we set out to fix).
    //
    // Fuzz a handful of overlay kinds × crop rects; any non-null
    // result must parse cleanly.
    const cropRects = [
      { x: 0, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0.6, h: 1 },
      { x: 0, y: 0, w: 1, h: 0.4 },
      { x: 0.2, y: 0.1, w: 0.5, h: 0.5 }
    ];
    const overlays: Overlay[] = [
      { kind: "text", point: { x: 0.3, y: 0.4 }, body: "x", size: "small", color: "auto" },
      { kind: "text", point: { x: 0.95, y: 0.5 }, body: "x", size: "small", color: "auto" },
      { kind: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 }, color: "auto" },
      { kind: "arrow", from: { x: 0.7, y: 0.5 }, to: { x: 0.9, y: 0.5 }, color: "auto" },
      { kind: "rect", rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, color: "auto" },
      { kind: "rect", rect: { x: 0.8, y: 0.1, w: 0.1, h: 0.1 }, color: "auto" },
      { kind: "highlight", rect: { x: 0, y: 0, w: 1, h: 1 } },
      { kind: "step", point: { x: 0.5, y: 0.9 }, index: 1 }
    ];
    for (const overlay of overlays) {
      for (const cropRect of cropRects) {
        const result = inverseTransformOverlayByCrop(overlay, cropRect);
        if (result === null) continue; // null = caller deletes, no schema check needed
        const parsed = OverlaySchema.safeParse(result);
        expect(
          parsed.success,
          `non-null transform output must pass schema — kind=${overlay.kind} cropRect=${JSON.stringify(cropRect)} result=${JSON.stringify(result)}`
        ).toBe(true);
      }
    }
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
