// Unit tests for the non-base raster layer style computation. This is
// the WYSIWYG-parity seam for the editor's raster LayerView: the math
// here must match `compositeRasterOntoAccumulator` in compose-tree.ts so
// a pasted image / captured cursor sits in the same place in the editor
// as it does in the exported composite.
//
// Math pinned:
//   • Identity transform → element is (natural/canvas) × 100%, at 0,0.
//   • Translate (tx, ty in canvas px) → left/top are (t/canvas) × 100%.
//   • Scale (transform[0]/[3]) folds into width/height.
//   • Opacity passes through; a degenerate canvas never yields NaN.

import { describe, expect, test } from "vitest";
import type { AffineTransform } from "@pwrsnap/shared";
import { computeRasterLayerStyle } from "../raster-layer-style";

const IDENTITY: AffineTransform = [1, 0, 0, 1, 0, 0];

describe("computeRasterLayerStyle", () => {
  test("identity transform: top-left, sized natural/canvas", () => {
    const style = computeRasterLayerStyle({
      transform: IDENTITY,
      naturalWidthPx: 100,
      naturalHeightPx: 50,
      canvasWidthPx: 200,
      canvasHeightPx: 100,
      opacity: 1
    });
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("0%");
    expect(style.top).toBe("0%");
    expect(style.width).toBe("50%"); // 100 / 200
    expect(style.height).toBe("50%"); // 50 / 100
    expect(style.opacity).toBe(1);
  });

  test("translation: left/top are (t / canvas) × 100%", () => {
    const style = computeRasterLayerStyle({
      transform: [1, 0, 0, 1, 40, 20],
      naturalWidthPx: 100,
      naturalHeightPx: 50,
      canvasWidthPx: 200,
      canvasHeightPx: 100,
      opacity: 1
    });
    expect(style.left).toBe("20%"); // 40 / 200
    expect(style.top).toBe("20%"); // 20 / 100
  });

  test("scale folds into width/height", () => {
    const style = computeRasterLayerStyle({
      transform: [2, 0, 0, 2, 0, 0],
      naturalWidthPx: 50,
      naturalHeightPx: 25,
      canvasWidthPx: 200,
      canvasHeightPx: 100,
      opacity: 1
    });
    expect(style.width).toBe("50%"); // 50 * 2 / 200
    expect(style.height).toBe("50%"); // 25 * 2 / 100
  });

  test("a cursor-like layer near the bottom-right places correctly", () => {
    // A 24×24 cursor at canvas (380, 280) on a 400×300 canvas.
    const style = computeRasterLayerStyle({
      transform: [1, 0, 0, 1, 380, 280],
      naturalWidthPx: 24,
      naturalHeightPx: 24,
      canvasWidthPx: 400,
      canvasHeightPx: 300,
      opacity: 1
    });
    expect(style.left).toBe("95%"); // 380 / 400
    expect(style.top).toBe(`${(280 / 300) * 100}%`);
    expect(style.width).toBe("6%"); // 24 / 400
  });

  test("opacity passes through", () => {
    const style = computeRasterLayerStyle({
      transform: IDENTITY,
      naturalWidthPx: 100,
      naturalHeightPx: 100,
      canvasWidthPx: 100,
      canvasHeightPx: 100,
      opacity: 0.5
    });
    expect(style.opacity).toBe(0.5);
  });

  test("degenerate (zero) canvas never produces NaN", () => {
    const style = computeRasterLayerStyle({
      transform: [1, 0, 0, 1, 10, 10],
      naturalWidthPx: 50,
      naturalHeightPx: 50,
      canvasWidthPx: 0,
      canvasHeightPx: 0,
      opacity: 1
    });
    expect(String(style.left)).not.toContain("NaN");
    expect(String(style.top)).not.toContain("NaN");
    expect(String(style.width)).not.toContain("NaN");
    expect(String(style.height)).not.toContain("NaN");
  });
});
