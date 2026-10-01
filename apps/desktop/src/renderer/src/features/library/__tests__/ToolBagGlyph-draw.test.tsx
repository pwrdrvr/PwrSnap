// Tool-bag slot names + glyphs for the Draw family. A slot is read at a
// glance by drawing what it would draw, and named for its tooltip and
// accessible label.

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolBagSlot } from "@pwrsnap/shared";
import { ToolBagGlyph, describeBagSlot } from "../ToolBagGlyph";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

function draw(mode: "pen" | "marker" | "airbrush" | "eraser", color = "red"): ToolBagSlot {
  return { tool: "draw", style: { mode, color, thickness: "medium" } };
}

function renderGlyph(slot: ToolBagSlot): HTMLElement {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(createElement(ToolBagGlyph, { slot }));
  });
  return host;
}

describe("Draw tool-bag slots", () => {
  test("are named for their color and tool", () => {
    expect(describeBagSlot(draw("pen"))).toBe("Red pen");
    expect(describeBagSlot(draw("marker", "yellow"))).toBe("Yellow marker");
    expect(describeBagSlot(draw("airbrush", "green"))).toBe("Green airbrush");
    expect(describeBagSlot({ ...draw("pen"), label: "Signature" })).toBe("Signature");
  });

  test("draw a pen loop, a flat translucent marker band, or a soft airbrush line, in the slot's color", () => {
    const pen = renderGlyph(draw("pen")).querySelector("path")!;
    expect(pen.getAttribute("stroke")).toBe("var(--swatch-red)");
    expect(pen.getAttribute("stroke-linecap")).toBe("round");

    const marker = renderGlyph(draw("marker", "yellow")).querySelector("line")!;
    expect(marker.getAttribute("stroke-linecap")).toBe("butt");
    expect(Number(marker.getAttribute("opacity"))).toBeLessThan(1);

    const airbrush = renderGlyph(draw("airbrush", "#123456"));
    expect(airbrush.querySelector("g")!.getAttribute("stroke")).toBe("#123456");
    const bands = Array.from(airbrush.querySelectorAll("path"));
    expect(bands.length).toBeGreaterThan(1);
    // Widest and faintest first, like the stroke it stands for.
    const widths = bands.map((b) => Number(b.getAttribute("stroke-width")));
    expect([...widths].sort((a, b) => b - a)).toEqual(widths);
  });
});
