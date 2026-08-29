// Bake-path tests for text overlay sizing. Same string-level assertion
// style as `rect-bake.test.ts` + `arrow-bake.test.ts` — pin the
// emitted SVG's `font-size` attribute against the expected SOURCE-
// shortSide-derived value, which is INVARIANT across crops.
//
// User-reported bug on PR #110 follow-up: clipboard:copy MED on a v2
// cropped capture showed the text shrunken relative to the editor
// view. Editor was patched in commit `881cff0` (renderer-side
// computeTextGlyphSize uses sourceShortSide); the bake's `textSvg`
// in `compose.ts` was NOT touched in that commit and still derives
// fontSize from the (cropped) CANVAS short side. Exports therefore
// render text at a different size than the editor.
//
// Pre-fix expected fail mode: `textSvg(data, canvasW, canvasH)` doesn't
// take source dims — the new signature (with source dims) doesn't
// exist yet, so adding source-dim args to the call is a compile
// error. That IS the red signal for these tests.

import { describe, expect, test } from "vitest";
import type { OverlayRow, TextSizeBucket } from "@pwrsnap/shared";
import { annotationBasisPx } from "@pwrsnap/shared";
import { textSvgForV2 } from "../compose";

function baseText(
  size: TextSizeBucket = "medium"
): Extract<OverlayRow["data"], { kind: "text" }> {
  return {
    kind: "text",
    point: { x: 0.5, y: 0.5 },
    body: "M",
    size,
    color: "auto"
  };
}

describe("textSvg (bake) — fontSize derives from SOURCE shortSide, not canvas", () => {
  test("uncropped (canvas == source): fontSize equals sourceBasis/30 for medium", () => {
    // Sanity baseline: when canvas dims match the source raster's
    // natural dims (no crop), the formula resolves to the same value
    // regardless of which dims drive it.
    const svg = textSvgForV2(baseText("medium"), 800, 600, 800, 600);
    // basis = max(900, 600, 1000/2) = 900 (floor branch) → 900/30 = 30.
    expect(annotationBasisPx(800, 600)).toBe(900);
    expect(svg).toMatch(/font-size="30"/);
  });

  test("v2 cropped (canvas shorter than source): fontSize uses the SOURCE basis", () => {
    // The bug case. Source raster is 3000×2000 (basis 2000); the canvas
    // was cropped down to 1500×1000 (basis 1000). A "medium" text on
    // this layer-tree row must render at sourceBasis/30 ≈ 66.7 canvas
    // pixels tall — NOT canvasBasis/30 ≈ 33.3.
    //
    // Dims are deliberately well ABOVE the basis floor: at 800×600 vs
    // 400×300 both sides floor at 900 and the assertion can't tell the
    // two apart.
    //
    // canvas-pixel space and source-pixel space share the same scale
    // in v2 (a crop is a viewport change, not a resampling), so a
    // fontSize of N in canvas pixels equals N source pixels — what
    // the editor's commit `881cff0` settled on.
    expect(annotationBasisPx(3000, 2000)).toBe(2000);
    expect(annotationBasisPx(1500, 1000)).toBe(1000);
    const svg = textSvgForV2(baseText("medium"), 1500, 1000, 3000, 2000);
    expect(
      svg,
      "textSvg must derive fontSize from the SOURCE raster's annotation basis, NOT the canvas's. Editor commit 881cff0 fixed the equivalent bug renderer-side; this test pins the bake side."
    ).toMatch(new RegExp(`font-size="${2000 / 30}"`));
    expect(svg).not.toMatch(new RegExp(`font-size="${1000 / 30}"`));
  });

  test("v2 cropped: every bucket derives from the SOURCE basis", () => {
    // Source 800×600, canvas 400×300 — same bug class for every
    // bucket. Divisors are 50 / 30 / 18 / 11.
    const basis = annotationBasisPx(800, 600);
    for (const [bucket, divisor] of [
      ["small", 50],
      ["medium", 30],
      ["large", 18],
      ["x-large", 11]
    ] as const) {
      const svg = textSvgForV2(baseText(bucket), 400, 300, 800, 600);
      expect(svg).toMatch(new RegExp(`font-size="${basis / divisor}"`));
    }
  });

  test("row with explicit sizePx field overrides bucket × source math", () => {
    // pwrdrvr/PwrSnap#110: the row carries `sizePx: 100` — bake must
    // emit font-size="100" regardless of bucket / source / canvas
    // dims. This is the load-bearing path for the new "Custom" UX:
    // a row whose sizePx is between two buckets renders at its
    // stored value, and the popover surfaces "Custom".
    const data: Extract<OverlayRow["data"], { kind: "text" }> = {
      ...baseText("medium"),
      sizePx: 100
    };
    const svg = textSvgForV2(data, 400, 300, 800, 600);
    expect(svg).toMatch(/font-size="100"/);
    expect(svg).not.toMatch(
      new RegExp(`font-size="${annotationBasisPx(800, 600) / 30}"`)
    );
  });

  test("legacy callers without source dims fall back to canvas shortSide", () => {
    // v1 captures and any caller that doesn't have source dims at
    // hand can omit them; in that case `textSvg` falls back to the
    // pre-#110-bake behavior (use canvas shortSide). Safe no-op for
    // v1 (where canvas == source) and existing v2 callers that
    // haven't been updated to thread source dims yet. This keeps the
    // fix backward-compatible at the API surface.
    const svg = textSvgForV2(baseText("medium"), 400, 300);
    expect(svg).toMatch(
      new RegExp(`font-size="${annotationBasisPx(400, 300) / 30}"`)
    );
  });
});

describe("textSvg (bake) — rotation", () => {
  // The SVG path is the FALLBACK bake (used in headless / non-Electron
  // contexts where the BrowserWindow HTML path can't run). The runtime
  // path is text-html-bake.ts (covered by text-html-bake-rotation.test.ts);
  // both must rotate so the two paths agree. The SVG path applies
  // rotation via a `<g transform="rotate(...)">` wrapper around the
  // <text>, pivoting on the body-box center — same convention as the
  // editor + HTML bake.
  test("rotated overlay wraps the text in a rotate() transform group", () => {
    const rotation = Math.PI / 4; // 45° → 45 degrees in the SVG
    const svg = textSvgForV2(
      { ...baseText("medium"), rotation },
      800,
      600,
      800,
      600
    );
    // SVG rotate() takes degrees; π/4 rad = 45°.
    expect(svg).toMatch(/<g transform="rotate\(45 /);
  });

  test("unrotated overlay emits no rotate() group", () => {
    const svg = textSvgForV2(baseText("medium"), 800, 600, 800, 600);
    expect(svg).not.toContain("rotate(");
  });
});


describe("textSvg (bake) — Border (contrast outline) modes", () => {
  test("legacy rows keep the historical translucent-black stroke attrs byte-identically", () => {
    const svg = textSvgForV2(baseText(), 800, 600, 800, 600);
    expect(svg).toContain('stroke="rgba(0,0,0,0.7)"');
    expect(svg).toContain('paint-order="stroke"');
  });

  test("outline:'black'/'white' swap the stroke to a solid color; width formula unchanged", () => {
    const black = textSvgForV2({ ...baseText(), outline: "black" }, 800, 600, 800, 600);
    expect(black).toContain('stroke="#000000"');
    // Glyph stroke stays fontSize × 0.08 — unchanged formula, new font size.
    expect(black).toMatch(
      new RegExp(`stroke-width="${(annotationBasisPx(800, 600) / 30) * 0.08}"`)
    );
    const white = textSvgForV2({ ...baseText(), outline: "white" }, 800, 600, 800, 600);
    expect(white).toContain('stroke="#ffffff"');
  });

  test("outline:'auto' resolves via the stored pick with a black fallback for text", () => {
    const stored = textSvgForV2(
      { ...baseText(), outline: "auto", outlineAuto: "white" },
      800,
      600,
      800,
      600
    );
    expect(stored).toContain('stroke="#ffffff"');
    const fallback = textSvgForV2({ ...baseText(), outline: "auto" }, 800, 600, 800, 600);
    expect(fallback).toContain('stroke="#000000"');
  });

  test("outline:'none' drops the stroke block entirely", () => {
    const svg = textSvgForV2({ ...baseText(), outline: "none" }, 800, 600, 800, 600);
    expect(svg).not.toContain("stroke=");
    expect(svg).not.toContain("paint-order");
  });

  test("outline:'stripe' coerces to solid black (text can't stripe a glyph stroke)", () => {
    const svg = textSvgForV2({ ...baseText(), outline: "stripe" }, 800, 600, 800, 600);
    expect(svg).toContain('stroke="#000000"');
    expect(svg).not.toContain("stroke-dasharray");
  });
});
