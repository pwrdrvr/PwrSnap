// Unit tests for the editor `<img>` style computation. Pinned by a
// real user bug on pwrdrvr/PwrSnap#110: off-origin crops looked
// correct in the bake (compose-tree.ts honors raster.transform.tx/ty)
// but the EDITOR view kept showing the top-left of the source,
// because the img was always pinned at the canvas's top-left corner
// regardless of the raster's translation.
//
// Math we're pinning:
//   • An UNCROPPED capture (source == canvas, transform identity)
//     → img is 100% × 100%, no transform attribute.
//   • An EDGE-aligned crop (source > canvas, transform identity)
//     → img is (source/canvas) × 100%, no transform attribute (the
//     overflow:hidden on .editor-canvas clips the right/bottom).
//   • An OFF-ORIGIN crop (source > canvas, transform with negative
//     tx/ty in source-pixel units) → img is (source/canvas) × 100%
//     AND `transform: translate(tx/sourceW × 100%, ty/sourceH × 100%)`
//     with transformOrigin pinned to (0, 0).

import { describe, expect, test } from "vitest";
import { computeEditorImageStyle } from "../editor-image-style";

describe("computeEditorImageStyle", () => {
  test("uncropped capture: img is 100% × 100% with no transform", () => {
    const style = computeEditorImageStyle({
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2880,
      canvasHeightPx: 1920,
      rasterTranslateXPx: 0,
      rasterTranslateYPx: 0
    });
    expect(style.width).toBe("100%");
    expect(style.height).toBe("100%");
    // No transform attribute — keeps the DOM identical to the pre-#110
    // shape for the common case.
    expect(style.transform).toBeUndefined();
    expect(style.transformOrigin).toBeUndefined();
  });

  test("edge-aligned crop (tx=0, ty=0): img is (source/canvas) × 100% with no transform", () => {
    // 60% top-left crop: canvas 1728×1152 of a 2880×1920 source.
    const style = computeEditorImageStyle({
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 1728,
      canvasHeightPx: 1152,
      rasterTranslateXPx: 0,
      rasterTranslateYPx: 0
    });
    // 2880/1728 = 1.6666... ≈ 166.67%
    const w = Number((style.width as string).replace("%", ""));
    expect(w).toBeCloseTo(166.6666, 3);
    const h = Number((style.height as string).replace("%", ""));
    expect(h).toBeCloseTo(166.6666, 3);
    expect(style.transform).toBeUndefined();
  });

  test("OFF-ORIGIN crop translates the img by raster.transform.{tx,ty} as % of img width/height", () => {
    // User's reported case on PR #110:
    //   center crop rect (0.179, 0.087, 0.771, 0.605) on 2880×1920
    //   → dispatcher sets raster.transform = [1,0,0,1, -516.6, -167.4]
    //   → canvas shrinks to 2221×1162
    //
    // Pre-fix: img sat at the canvas's top-left, so the visible
    // region was source pixels (0..2221, 0..1162) — top-left of the
    // source. User reported "we ended up with the remaining image
    // after crop starting at the same original top-left coord. That's
    // BAD."
    //
    // Post-fix: img is translated by (tx/sourceW × 100%, ty/sourceH × 100%)
    // = (-17.9%, -8.72%) of img width/height. transformOrigin is
    // pinned to (0, 0). Visible region is source pixels (516..2737,
    // 167..1329) — the user's chosen middle of the source.
    const style = computeEditorImageStyle({
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2221,
      canvasHeightPx: 1162,
      rasterTranslateXPx: -516.6,
      rasterTranslateYPx: -167.4
    });
    expect(style.transform).toBeDefined();
    // Parse the translate values out and check the math.
    const match = /translate\(([-\d.]+)%,\s*([-\d.]+)%\)/.exec(
      String(style.transform)
    );
    expect(match, "transform must be a translate(x%, y%)").not.toBeNull();
    if (match === null) throw new Error("unreachable");
    const txPct = Number(match[1]);
    const tyPct = Number(match[2]);
    expect(txPct).toBeCloseTo((-516.6 / 2880) * 100, 3); // ≈ -17.94%
    expect(tyPct).toBeCloseTo((-167.4 / 1920) * 100, 3); // ≈ -8.72%
    // transformOrigin MUST be (0, 0) — the default for img is
    // "50% 50%" which would shift the math by half the img's size.
    expect(style.transformOrigin).toBe("0 0");
  });

  test("transform is skipped when both translations are exactly zero (no DOM churn for the common case)", () => {
    const style = computeEditorImageStyle({
      sourceWidthPx: 1000,
      sourceHeightPx: 1000,
      canvasWidthPx: 600,
      canvasHeightPx: 600,
      rasterTranslateXPx: 0,
      rasterTranslateYPx: 0
    });
    expect(style.transform).toBeUndefined();
    expect(style.transformOrigin).toBeUndefined();
  });

  test("transform fires when ONLY tx is non-zero (asymmetric off-origin crops)", () => {
    const style = computeEditorImageStyle({
      sourceWidthPx: 1000,
      sourceHeightPx: 1000,
      canvasWidthPx: 800,
      canvasHeightPx: 1000,
      rasterTranslateXPx: -200,
      rasterTranslateYPx: 0
    });
    expect(style.transform).toBe("translate(-20%, 0%)");
    expect(style.transformOrigin).toBe("0 0");
  });

  test("zero canvas dims (pre-measurement frame) don't divide by zero", () => {
    const style = computeEditorImageStyle({
      sourceWidthPx: 1000,
      sourceHeightPx: 1000,
      canvasWidthPx: 0,
      canvasHeightPx: 0,
      rasterTranslateXPx: 0,
      rasterTranslateYPx: 0
    });
    // Falls back to source dims; ratio is 1.0 → 100%.
    expect(style.width).toBe("100%");
    expect(style.height).toBe("100%");
  });
});
