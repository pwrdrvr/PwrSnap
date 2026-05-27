// Tests for `computeTextHtmlStyle` + `serializeStyleAttribute` — the
// single source of truth that backstops "editor display = editor edit
// = baked export". If any of these tests start failing, one of the
// three surfaces has drifted from the shared contract.

import { describe, expect, test } from "vitest";
import {
  computeTextHtmlStyle,
  serializeStyleAttribute
} from "../text-html-style";

describe("computeTextHtmlStyle — geometry + sizing", () => {
  test("anchor point becomes wrapper left/top percentages", () => {
    const result = computeTextHtmlStyle({
      point: { x: 0.25, y: 0.6 },
      size: "medium",
      weight: 700,
      storedSizePx: undefined,
      colorHex: "#000000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    expect(result.wrapper.left).toBe("25%");
    expect(result.wrapper.top).toBe("60%");
    // Vertical centering on the anchor — matches the SVG dominant-
    // baseline="central" behavior the editor previously had.
    expect(result.wrapper.transform).toBe("translateY(-50%)");
    expect(result.wrapper.position).toBe("absolute");
  });

  test("fontPx is sizePx × (canvasCss / canvasPx) scale factor", () => {
    // Uncropped capture: source == canvas == 1920×1080. Medium bucket
    // sizePx = 1080/30 = 36 source px. Canvas CSS height matches
    // canvas pixel height → scale factor 1 → fontPx = 36.
    const result = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    expect(result.fontPx).toBeCloseTo(36, 5);
    expect(result.glyph.fontSize).toBe("36px");
  });

  test("fontPx scales when canvas CSS dims are SMALLER than canvas px (editor zoomed-fit)", () => {
    // Editor displays a 1920×1080 image inside a 480×270 CSS box (the
    // window is small). fontPx must scale down so the displayed glyph
    // matches the rendered SVG/image scale.
    const result = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 270
    });
    // sizePx = 36 source px, scale = 270/1080 = 0.25, fontPx = 9.
    expect(result.fontPx).toBeCloseTo(9, 5);
  });

  test("storedSizePx overrides bucket math (matches TextGlyph behavior)", () => {
    const result = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "small", // would normally give 1080/50 = 21.6
      weight: 600,
      storedSizePx: 50, // explicit override
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    // storedSizePx wins — fontPx = 50 × 1.0 = 50.
    expect(result.fontPx).toBeCloseTo(50, 5);
  });

  test("sources differ from canvas (cropped capture) — sizePx tracks source short-side", () => {
    // Crop scenario: source is 1920×1080 but canvas is now 800×400
    // (user cropped to a region). The text's absolute size must stay
    // constant across crops — derived from SOURCE short side (1080),
    // NOT canvas short side (400). Medium bucket sizePx = 1080/30 = 36.
    const result = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 800,
      canvasHeightPx: 400,
      canvasCssHeight: 400
    });
    // sizePx in image space = 36 (constant across crops).
    // fontPx = sizePx × (canvasCssHeight / canvasHeightPx) = 36 × 1.0 = 36.
    expect(result.fontPx).toBeCloseTo(36, 5);
  });

  test("zero-height canvas falls back to 16px (defensive — initial layout)", () => {
    const result = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 0 // canvas not yet measured
    });
    expect(result.fontPx).toBe(16);
  });
});

describe("computeTextHtmlStyle — glyph style", () => {
  test("emits the SVG-parity rendering controls", () => {
    const result = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#0066ff",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    // The complete SVG-parity quintet. Drift on any of these brings
    // back the visible wiggle between display and edit (the
    // pre-unification bug class).
    expect(result.glyph.WebkitFontSmoothing).toBe("antialiased");
    expect(result.glyph.textRendering).toBe("geometricPrecision");
    expect(result.glyph.fontKerning).toBe("normal");
    expect(result.glyph.fontFeatureSettings).toBe("normal");
    expect(result.glyph.fontVariantLigatures).toBe("normal");
  });

  test("emits matching text-stroke halo (8% of fontPx, clamped to 1px)", () => {
    // 36px font → 36*0.08 = 2.88px stroke.
    const big = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    expect(big.glyph.WebkitTextStroke).toBe("2.88px rgba(0,0,0,0.6)");

    // 10px font → 0.8 → clamped to 1px so small text still has halo.
    const tiny = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: 10,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    expect(tiny.glyph.WebkitTextStroke).toBe("1px rgba(0,0,0,0.6)");
  });

  test("paint-order is 'stroke' so fill covers the stroke's inside half (no glyph bloat)", () => {
    const result = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    expect(result.glyph.paintOrder).toBe("stroke");
  });

  test("colorHex passes through verbatim (caller resolves 'auto' → CSS var or hex)", () => {
    const cssVar = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "var(--accent, #ff8a1f)",
      sourceWidthPx: 100,
      sourceHeightPx: 100,
      canvasWidthPx: 100,
      canvasHeightPx: 100,
      canvasCssHeight: 100
    });
    expect(cssVar.glyph.color).toBe("var(--accent, #ff8a1f)");

    const hex = computeTextHtmlStyle({
      point: { x: 0, y: 0 },
      size: "medium",
      weight: 600,
      storedSizePx: undefined,
      colorHex: "#ff0000",
      sourceWidthPx: 100,
      sourceHeightPx: 100,
      canvasWidthPx: 100,
      canvasHeightPx: 100,
      canvasCssHeight: 100
    });
    expect(hex.glyph.color).toBe("#ff0000");
  });
});

describe("serializeStyleAttribute — React-camelCase → CSS-kebab", () => {
  test("plain camelCase → kebab-case", () => {
    expect(serializeStyleAttribute({ fontSize: "16px" })).toBe("font-size: 16px");
    expect(serializeStyleAttribute({ fontWeight: 700 })).toBe("font-weight: 700");
    expect(serializeStyleAttribute({ textRendering: "geometricPrecision" })).toBe(
      "text-rendering: geometricPrecision"
    );
  });

  test("WebKit prefix gets the leading dash", () => {
    expect(serializeStyleAttribute({ WebkitFontSmoothing: "antialiased" })).toBe(
      "-webkit-font-smoothing: antialiased"
    );
    expect(serializeStyleAttribute({ WebkitTextStroke: "2px black" })).toBe(
      "-webkit-text-stroke: 2px black"
    );
  });

  test("multiple properties join with '; '", () => {
    const out = serializeStyleAttribute({
      position: "absolute",
      left: "25%",
      fontSize: "16px"
    });
    expect(out).toBe("position: absolute; left: 25%; font-size: 16px");
  });

  test("end-to-end: computeTextHtmlStyle → serializeStyleAttribute produces valid CSS", () => {
    const { glyph } = computeTextHtmlStyle({
      point: { x: 0.5, y: 0.5 },
      size: "medium",
      weight: 700,
      storedSizePx: undefined,
      colorHex: "#000",
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      canvasWidthPx: 1920,
      canvasHeightPx: 1080,
      canvasCssHeight: 1080
    });
    const serialized = serializeStyleAttribute(glyph);
    // Spot-check the key SVG-parity properties — these are the ones
    // that, if mis-serialized, would visibly break parity in the bake.
    expect(serialized).toContain("-webkit-font-smoothing: antialiased");
    expect(serialized).toContain("text-rendering: geometricPrecision");
    expect(serialized).toContain("font-kerning: normal");
    expect(serialized).toContain("paint-order: stroke");
    // No camelCase leaks through on the PROPERTY side of any
    // declaration. (Values can legitimately contain mixed case — e.g.,
    // "geometricPrecision" is the canonical text-rendering value, and
    // the font-family stack includes "BlinkMacSystemFont".)
    const props = serialized
      .split(";")
      .map((decl) => decl.split(":")[0]?.trim() ?? "");
    for (const prop of props) {
      expect(prop, `property "${prop}" leaked camelCase`).not.toMatch(/[a-z][A-Z]/);
    }
  });
});
