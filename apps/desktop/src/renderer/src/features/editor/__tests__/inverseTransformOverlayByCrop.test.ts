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
      kind: "shape",
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      color: "auto"
    };
    const result = inverseTransformOverlayByCrop(rect, HALF_CROP);
    if (result?.kind !== "shape") throw new Error("kind preserved");
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

describe("inverseTransformOverlayByCrop — overlays in cropped-away region PERSIST with out-of-canvas coords (crop is a viewport, not destructive)", () => {
  // Per pwrdrvr/PwrSnap#110 review feedback: crop is a viewport
  // change, not a destructive op. Overlays outside the cropped
  // viewport must survive as DATA — invisible while clipped, but
  // restored when the crop is undone. The schema was widened
  // (NormalizedScalar: .min(0).max(1) → .finite()) specifically to
  // permit out-of-canvas coords; renderer (SVG overflow:hidden) and
  // bake (sharp composite) clip at paint time.
  //
  // The old behavior — return null for "out of bounds" so the
  // dispatcher deletes the layer — made data loss PERMANENT. Undo
  // had nothing to restore. Tests below pin the new "just emit the
  // math; never delete for being out of bounds" contract.

  test("text: anchor past new right edge → preserved with point.x > 1", () => {
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
    expect(result).not.toBeNull();
    if (result?.kind !== "text") throw new Error("kind preserved");
    // 0.95 / 0.6 = 1.5833... — out of the new canvas, but preserved.
    expect(result.point.x).toBeCloseTo(0.95 / 0.6, 5);
    expect(result.point.y).toBeCloseTo(0.5, 6);
    // Schema must accept the out-of-canvas coord (load-bearing
    // invariant — the upsert downstream uses the same schema).
    expect(OverlaySchema.safeParse(result).success).toBe(true);
  });

  test("step: anchor past new bottom edge → preserved with point.y > 1", () => {
    const step: Overlay = { kind: "step", point: { x: 0.5, y: 0.9 }, index: 1 };
    const result = inverseTransformOverlayByCrop(step, {
      x: 0,
      y: 0,
      w: 1,
      h: 0.5
    });
    expect(result).not.toBeNull();
    if (result?.kind !== "step") throw new Error("kind preserved");
    expect(result.point.x).toBeCloseTo(0.5, 6);
    expect(result.point.y).toBeCloseTo(0.9 / 0.5, 5); // 1.8
    expect(OverlaySchema.safeParse(result).success).toBe(true);
  });

  test("rect crossing the new right edge → preserved with w extending past 1 (NO clamp)", () => {
    // Rect starts in the kept region and extends past the crop
    // boundary. Pre-fix: clamped to the canvas intersection (data
    // loss on undo). Post-fix: w preserved verbatim — renderer
    // clips at canvas edge at paint time.
    const rect: Overlay = {
      kind: "shape",
      rect: { x: 0.3, y: 0.3, w: 0.6, h: 0.2 },
      color: "auto"
    };
    // Crop to keep left 50%. Transformed rect:
    //   x = 0.3 / 0.5 = 0.6, y = 0.3, w = 0.6 / 0.5 = 1.2, h = 0.2
    const result = inverseTransformOverlayByCrop(rect, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    if (result?.kind !== "shape") throw new Error("kind preserved");
    expect(result.rect.x).toBeCloseTo(0.6, 6);
    expect(result.rect.y).toBeCloseTo(0.3, 6);
    expect(result.rect.w).toBeCloseTo(1.2, 6); // NOT clamped to 0.4
    expect(result.rect.h).toBeCloseTo(0.2, 6);
    expect(OverlaySchema.safeParse(result).success).toBe(true);
  });

  test("rect entirely outside the new canvas → preserved with x > 1", () => {
    const rect: Overlay = {
      kind: "shape",
      rect: { x: 0.8, y: 0.1, w: 0.1, h: 0.1 },
      color: "auto"
    };
    // Crop to keep left 50% — rect's old absolute pixels at
    // x:0.8-0.9 are entirely past the new right edge (x=1 in new
    // norm space = old absolute pixel 0.5). New x = 0.8/0.5 = 1.6.
    const result = inverseTransformOverlayByCrop(rect, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    expect(result).not.toBeNull();
    if (result?.kind !== "shape") throw new Error("kind preserved");
    expect(result.rect.x).toBeCloseTo(1.6, 5);
    expect(result.rect.y).toBeCloseTo(0.1, 6);
    expect(result.rect.w).toBeCloseTo(0.2, 6); // 0.1/0.5
    expect(result.rect.h).toBeCloseTo(0.1, 6);
    expect(OverlaySchema.safeParse(result).success).toBe(true);
  });

  test("arrow with one endpoint past crop boundary → endpoint preserved past 1 (NO clamp)", () => {
    // Pre-fix: clamped the out-of-bounds endpoint to canvas edge
    // (subtly distorts arrow direction on undo). Post-fix: both
    // endpoints carry through exactly.
    const arrow: Overlay = {
      kind: "arrow",
      from: { x: 0.1, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      color: "auto"
    };
    // Crop to keep left 50% — from: 0.1/0.5 = 0.2 (kept), to: 0.9/0.5 = 1.8.
    const result = inverseTransformOverlayByCrop(arrow, {
      x: 0,
      y: 0,
      w: 0.5,
      h: 1
    });
    if (result?.kind !== "arrow") throw new Error("kind preserved");
    expect(result.from.x).toBeCloseTo(0.2, 6);
    expect(result.from.y).toBeCloseTo(0.5, 6);
    expect(result.to.x).toBeCloseTo(1.8, 5); // NOT clamped to 1
    expect(result.to.y).toBeCloseTo(0.5, 6);
    expect(OverlaySchema.safeParse(result).success).toBe(true);
  });

  test("arrow with BOTH endpoints past same edge → preserved (no special-casing for fully-out segments)", () => {
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
    if (result?.kind !== "arrow") throw new Error("kind preserved");
    expect(result.from.x).toBeCloseTo(1.4, 5); // 0.7/0.5
    expect(result.from.y).toBeCloseTo(0.5, 6);
    expect(result.to.x).toBeCloseTo(1.8, 5);
    expect(result.to.y).toBeCloseTo(0.5, 6);
    expect(OverlaySchema.safeParse(result).success).toBe(true);
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
    // NormalizedScalar is `.finite()` (post-#110 widening), so any
    // real-number result the helper emits must parse cleanly — out-
    // of-canvas coords (x>1, y<0, etc.) are explicitly allowed because
    // overlays at absolute source pixels outside the cropped viewport
    // are preserved as DATA. The schema only rejects NaN/Infinity
    // (which would crash the renderer); the helper never emits those
    // because it only does finite arithmetic on finite inputs.
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
      { kind: "shape", rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, color: "auto" },
      { kind: "shape", rect: { x: 0.8, y: 0.1, w: 0.1, h: 0.1 }, color: "auto" },
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

  test("overlays outside the new canvas are PRESERVED (out-of-[0,1] coords valid) so crop is reversible", () => {
    // User's correct model: crop is a viewport, not a destructive op.
    // Text at the right edge of the source should persist as DATA
    // through a crop — invisible while clipped, but restored when the
    // crop is undone. So the transform helper must NOT return null for
    // text whose anchor falls outside the new canvas — instead it
    // returns the transformed point.x > 1, and the schema permits it.
    // Renderer/bake clip at canvas boundary at paint time (SVG overflow
    // + sharp composite clipping).
    //
    // Round-trip check: forward transform of a right-edge text by
    // rect.w=0.6 should give point.x = 0.95/0.6 = 1.583, and the
    // reverse transform by rect.w = 1/0.6 = 1.667 should restore
    // point.x = 1.583/1.667 = 0.95.
    const text: Overlay = {
      kind: "text",
      point: { x: 0.95, y: 0.5 },
      body: "edge",
      size: "small",
      color: "auto"
    };
    const forwardRect = { x: 0, y: 0, w: 0.6, h: 1 };
    const inverseRect = { x: 0, y: 0, w: 1 / 0.6, h: 1 };

    const cropped = inverseTransformOverlayByCrop(text, forwardRect);
    expect(
      cropped,
      "right-edge text must NOT be deleted by crop — undo would have nothing to restore"
    ).not.toBeNull();
    if (cropped?.kind !== "text") throw new Error("kind preserved");
    expect(cropped.point.x).toBeCloseTo(1.5833, 3);

    // The transformed overlay must pass the schema (otherwise the
    // bus rejects on upsert and we lose the data anyway).
    const parsed = OverlaySchema.safeParse(cropped);
    expect(
      parsed.success,
      "cropped overlay with out-of-canvas point must pass schema"
    ).toBe(true);

    // Reverse transform = identity.
    const restored = inverseTransformOverlayByCrop(cropped, inverseRect);
    if (restored?.kind !== "text") throw new Error("kind preserved");
    expect(restored.point.x).toBeCloseTo(0.95, 5);
    expect(restored.point.y).toBeCloseTo(0.5, 5);
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
