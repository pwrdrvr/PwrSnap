// The Draw mode tooltip's picture: drawn by the editor's own stroke
// renderer, in the bar's color and weight, with the eraser's real cut.

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { renderTipPreview } from "../../../lib/tip-previews";
import { DRAW_MODE_TIP, drawModeTipProps } from "../draw-mode-preview";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** A mode button carrying `drawModeTipProps`, as the property bar renders it. */
function anchor(attrs: Record<string, string>): HTMLElement {
  const button = document.createElement("button");
  for (const [name, value] of Object.entries(attrs)) button.setAttribute(name, value);
  return button;
}

function render(attrs: Record<string, string>): HTMLElement {
  const picture: ReactElement | null = renderTipPreview(DRAW_MODE_TIP, anchor(attrs));
  act(() => root.render(picture));
  return host;
}

const glyphs = (el: HTMLElement) => [...el.querySelectorAll('[data-testid="stroke-glyph"]')];

describe("Draw mode tooltip preview", () => {
  test("each mode draws with its own tool", () => {
    for (const mode of ["pen", "marker", "airbrush"] as const) {
      const el = render(drawModeTipProps(mode, { color: "#2fbf4a", thickness: "medium" }));
      expect(el.querySelector('[data-testid="draw-tip-preview"]')?.getAttribute("data-mode")).toBe(mode);
      expect(glyphs(el).length).toBeGreaterThan(0);
      expect(glyphs(el).every((g) => g.getAttribute("data-tool") === mode)).toBe(true);
    }
  });

  test("it paints in the bar's color", () => {
    const el = render(drawModeTipProps("pen", { color: "#2fbf4a", thickness: "medium" }));
    expect(glyphs(el)[0]?.getAttribute("stroke")).toBe("#2fbf4a");
  });

  test("the marker's two passes are separate segments, so the crossing darkens", () => {
    const el = render(drawModeTipProps("marker", { color: "#ff5a5a", thickness: "medium" }));
    expect(glyphs(el)).toHaveLength(2);
  });

  test("a heavier weight draws a wider stroke", () => {
    const width = (thickness: "small" | "x-large"): number =>
      Number(glyphs(render(drawModeTipProps("pen", { color: "#2fbf4a", thickness })))[0]?.getAttribute("stroke-width"));
    expect(width("x-large")).toBeGreaterThan(width("small") * 2);
  });

  test("the eraser cuts the wave in two, as wide as its own footprint", () => {
    const small = render(drawModeTipProps("eraser", { color: "#2fbf4a", thickness: "small" }));
    expect(glyphs(small)).toHaveLength(2);
    const ringSmall = Number(small.querySelector(".draw-tip__ring")?.getAttribute("r"));
    const large = render(drawModeTipProps("eraser", { color: "#2fbf4a", thickness: "x-large" }));
    const ringLarge = Number(large.querySelector(".draw-tip__ring")?.getAttribute("r"));
    expect(ringLarge).toBeGreaterThan(ringSmall);
  });

  test("a button with no mode shows no picture", () => {
    expect(renderTipPreview(DRAW_MODE_TIP, anchor({ "data-tip-preview": DRAW_MODE_TIP }))).toBeNull();
  });

  test("a token color is resolved the way a committed stroke's is", () => {
    expect(drawModeTipProps("pen", { color: "auto", thickness: "auto" })["data-draw-color"]).toBe("auto");
  });
});
