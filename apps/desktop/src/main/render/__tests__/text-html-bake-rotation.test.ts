// Rotation contract for the HTML text bake.
//
// A rotated TextOverlay renders rotated in the editor — TextHtml.tsx
// and computeTextHtmlStyle apply `rotate(rad)` to the wrapper's CSS
// transform. The BAKE path (text-html-bake.ts `buildBakeHtml`) is
// supposed to be pixel-identical to the editor because both consume
// `computeTextHtmlStyle`. It regressed: `buildBakeHtml` called
// computeTextHtmlStyle WITHOUT threading the overlay's `rotation`, so
// the helper defaulted rotation to 0 and the baked PNG showed
// horizontal text. The editor showed rotated text; the export did not.
//
// These tests pin rotation at the HTML seam — the generated wrapper
// style MUST carry the rotate transform when the overlay has a nonzero
// rotation and MUST NOT when it doesn't. That HTML is exactly what the
// hidden BrowserWindow renders and capturePage rasterizes, so asserting
// it proves the baked glyph is actually rotated without spinning up
// Electron.
//
// `buildBakeHtml` is pure (data in, HTML string out). We mock `electron`
// only so the module's top-level `import { BrowserWindow } from
// "electron"` resolves under vitest's node env — buildBakeHtml never
// touches BrowserWindow itself.

import { describe, expect, test, vi } from "vitest";
import type { Overlay } from "@pwrsnap/shared";

vi.mock("electron", () => ({
  BrowserWindow: class {}
}));

const { buildBakeHtml } = await import("../text-html-bake");

function textOverlay(
  rotation: number | undefined
): Extract<Overlay, { kind: "text" }> {
  return {
    kind: "text",
    point: { x: 0.5, y: 0.5 },
    body: "Hi Mom",
    size: "medium",
    color: "auto",
    ...(rotation !== undefined ? { rotation } : {})
  };
}

const DIMS = {
  renderWidthPx: 800,
  renderHeightPx: 600,
  canvasWidthPx: 800,
  canvasHeightPx: 600,
  sourceWidthPx: 800,
  sourceHeightPx: 600
};

describe("text-html-bake: rotation is baked into the HTML", () => {
  test("a rotated overlay's wrapper carries the rotate() transform", () => {
    const rotation = Math.PI / 4; // 45°
    const html = buildBakeHtml({ data: textOverlay(rotation), ...DIMS });
    // The baked wrapper must rotate by the overlay's radians — the same
    // transform the editor applies via computeTextHtmlStyle. Pre-fix the
    // bake dropped rotation entirely (wrapper was just
    // `translateY(-50%)`), so the export showed horizontal text while
    // the editor showed it rotated.
    expect(html).toContain(`rotate(${rotation}rad)`);
  });

  test("rotation is baked for every quadrant angle, not just 45°", () => {
    for (const rotation of [Math.PI / 6, -Math.PI / 3, Math.PI, 2.5]) {
      const html = buildBakeHtml({ data: textOverlay(rotation), ...DIMS });
      expect(html).toContain(`rotate(${rotation}rad)`);
    }
  });

  test("an unrotated overlay's wrapper has no rotate() transform", () => {
    const html = buildBakeHtml({ data: textOverlay(undefined), ...DIMS });
    expect(html).not.toContain("rotate(");
    // Still vertically centered on the anchor like before — only the
    // rotate fragment is conditional.
    expect(html).toContain("translateY(-50%)");
  });
});
