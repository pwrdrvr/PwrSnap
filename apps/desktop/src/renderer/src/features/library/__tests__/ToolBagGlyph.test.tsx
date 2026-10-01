import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { computeShapeStrokeDash, defaultEditorToolBag, type ToolBagSlot } from "@pwrsnap/shared";
import { describeBagSlot, ToolBagGlyph } from "../ToolBagGlyph";

type ShapeSlotStyle = Extract<ToolBagSlot, { tool: "shape" }>["style"];
type ArrowSlotStyle = Extract<ToolBagSlot, { tool: "arrow" }>["style"];

const FACTORY_BOX = defaultEditorToolBag().slots[6];
const FACTORY_ARROW = defaultEditorToolBag().slots[0];

function box(patch: Partial<ShapeSlotStyle>): ToolBagSlot {
  if (FACTORY_BOX?.tool !== "shape") throw new Error("factory slot 7 is not a shape");
  return { tool: "shape", style: { ...FACTORY_BOX.style, ...patch } };
}

function arrow(patch: Partial<ArrowSlotStyle>): ToolBagSlot {
  if (FACTORY_ARROW?.tool !== "arrow") throw new Error("factory slot 1 is not an arrow");
  return { tool: "arrow", style: { ...FACTORY_ARROW.style, ...patch } };
}

describe("describeBagSlot — stroke pattern", () => {
  test("names a dashed or dotted box, and says nothing for a solid one", () => {
    expect(describeBagSlot(box({ strokeStyle: "dashed" }))).toBe("Red dashed box");
    expect(describeBagSlot(box({ strokeStyle: "dotted" }))).toBe("Red dotted box");
    expect(describeBagSlot(box({ strokeStyle: "solid" }))).toBe("Red box");
  });

  test("a filled box has no outline, so its pattern goes unnamed", () => {
    expect(describeBagSlot(box({ filled: true, strokeStyle: "dashed" }))).toBe("Red filled box");
  });

  test("an arrow's stem uses the same words", () => {
    expect(describeBagSlot(arrow({ stemStyle: "dashed" }))).toBe("Red dashed arrow");
    expect(describeBagSlot(arrow({ stemStyle: "dotted" }))).toBe("Red dotted arrow");
  });
});

describe("ToolBagGlyph — shape stroke pattern", () => {
  test("a dashed box draws the editor's corner-aligned pattern, round-capped", () => {
    const html = renderToStaticMarkup(<ToolBagGlyph slot={box({ strokeStyle: "dashed" })} />);
    // Same helper the editor and bake use: the 18×11 glyph box, in a
    // glyph-sized pattern unit.
    const expected = computeShapeStrokeDash("dashed", "rect", 18, 11, 0, 0.75)!;
    expect(html).toContain(`stroke-dasharray="${expected.dasharray}"`);
    expect(html).toContain(`stroke-dashoffset="${expected.dashoffset}"`);
    expect(html).toContain('stroke-linecap="round"');
    // A rounded corner would start the path past the corner and put the
    // pattern out of phase.
    expect(html).not.toContain("rx=");
  });

  test("a solid box and a filled dashed box draw no dash", () => {
    for (const slot of [box({ strokeStyle: "solid" }), box({ filled: true, strokeStyle: "dashed" })]) {
      expect(renderToStaticMarkup(<ToolBagGlyph slot={slot} />)).not.toContain("stroke-dasharray");
    }
  });
});
