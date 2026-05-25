// Bake-path tests for highlight color, opacity, and blend mode. The
// blend mode is NOT in the SVG (resvg doesn't honor mix-blend-mode
// reliably) — it's resolved separately via highlightBlendModeForV2
// and attached to the sharp composite layer. These tests pin both
// halves so the next refactor doesn't silently drop blend back to
// "over" (which was the regression that shipped to a user — three
// different blend modes rendered identically because the bake path
// ignored the field entirely).

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import { highlightBlendModeForV2, highlightSvgForV2 } from "../compose";

const W = 800;
const H = 600;

function baseHighlight(): Extract<OverlayRow["data"], { kind: "highlight" }> {
  return {
    kind: "highlight",
    rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
  };
}

describe("highlightSvg (bake) — color + opacity", () => {
  test("legacy row (no color / no opacity) renders marker yellow at 0.3 opacity", () => {
    const svg = highlightSvgForV2(baseHighlight(), W, H);
    // Marker-pen default from shared/overlay-schemas.
    expect(svg).toContain('fill="#facc15"');
    expect(svg).toContain('fill-opacity="0.3"');
  });

  test("explicit color hex is honored verbatim", () => {
    const svg = highlightSvgForV2(
      { ...baseHighlight(), color: "#00ff00" },
      W,
      H
    );
    expect(svg).toContain('fill="#00ff00"');
    expect(svg).not.toContain("#facc15");
  });

  test('color: "auto" falls back to the marker-yellow default', () => {
    const svg = highlightSvgForV2({ ...baseHighlight(), color: "auto" }, W, H);
    expect(svg).toContain('fill="#facc15"');
  });

  test("explicit opacity is honored verbatim", () => {
    const svg = highlightSvgForV2(
      { ...baseHighlight(), opacity: 0.65 },
      W,
      H
    );
    expect(svg).toContain('fill-opacity="0.65"');
  });
});

describe("highlightBlendMode (bake) — sharp composite blend option", () => {
  test("legacy row (no blend field) resolves to 'multiply' (default)", () => {
    expect(highlightBlendModeForV2(baseHighlight())).toBe("multiply");
  });

  test("multiply round-trips", () => {
    expect(
      highlightBlendModeForV2({ ...baseHighlight(), blend: "multiply" })
    ).toBe("multiply");
  });

  test("screen round-trips", () => {
    expect(
      highlightBlendModeForV2({ ...baseHighlight(), blend: "screen" })
    ).toBe("screen");
  });

  test("overlay round-trips", () => {
    expect(
      highlightBlendModeForV2({ ...baseHighlight(), blend: "overlay" })
    ).toBe("overlay");
  });

  test("blend is NOT baked into the SVG (must be applied at composite)", () => {
    // If a future refactor ever tries to emit mix-blend-mode in the
    // SVG, resvg will silently drop it and the bake will quietly stop
    // honoring blend modes. Keep the SVG blend-mode-free.
    const svg = highlightSvgForV2(
      { ...baseHighlight(), blend: "screen" },
      W,
      H
    );
    expect(svg).not.toContain("mix-blend-mode");
    expect(svg).not.toContain("blend");
  });
});
