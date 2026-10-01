import { describe, expect, test } from "vitest";
import { defaultEditorToolBag, type ToolBagSlot } from "@pwrsnap/shared";
import { bagSlotIndexForCode, slotFieldsForLayer, styleValuesEqual } from "../tool-bag";

function slot(index: number): ToolBagSlot {
  const value = defaultEditorToolBag().slots[index];
  if (value == null) throw new Error(`default slot ${index + 1} is empty`);
  return value;
}

const RED_ARROW = slot(0);
const YELLOW_RANGE = slot(3);
const HIGHLIGHT = slot(4);
const BLUR = slot(5);
const RED_BOX = slot(6);
const RED_TEXT = slot(7);

describe("slotFieldsForLayer — the ⇧1–9 paste", () => {
  test("an arrow slot restyles a box without giving it arrow heads", () => {
    expect(slotFieldsForLayer(YELLOW_RANGE, "shape")).toEqual([
      ["color", "yellow"],
      ["thickness", "small"],
      ["outline", "auto"]
    ]);
  });

  test("an arrow slot onto an arrow carries every head field, so a range makes a double-ended arrow a range", () => {
    expect(slotFieldsForLayer(YELLOW_RANGE, "arrow")).toEqual([
      ["color", "yellow"],
      ["thickness", "small"],
      ["outline", "auto"],
      ["endStyle", "bar"],
      ["stemStyle", "solid"],
      ["doubleEnded", true]
    ]);
  });

  test("a single-ended slot turns a double-ended arrow single-ended", () => {
    const fields = slotFieldsForLayer(RED_ARROW, "arrow");
    expect(fields).toContainEqual(["doubleEnded", false]);
  });

  test("a box slot keeps the target's geometric kind — it never sends `shape`", () => {
    const fields = slotFieldsForLayer(RED_BOX, "shape");
    expect(fields.map(([field]) => field)).toEqual(["color", "thickness", "outline", "filled"]);
  });

  test("text takes color and border, never stroke thickness; a striped border becomes Auto", () => {
    const striped: ToolBagSlot = {
      tool: "arrow",
      style: { ...(RED_ARROW.style as Extract<ToolBagSlot, { tool: "arrow" }>["style"]), outline: "stripe" }
    };
    expect(slotFieldsForLayer(striped, "text")).toEqual([
      ["color", "red"],
      ["outline", "auto"]
    ]);
  });

  test("text onto text carries size and weight", () => {
    expect(slotFieldsForLayer(RED_TEXT, "text")).toEqual([
      ["color", "red"],
      ["outline", "auto"],
      ["fontSize", "medium"],
      ["weight", "regular"]
    ]);
  });

  test("highlight onto highlight carries opacity and blend; onto an arrow, only color", () => {
    expect(slotFieldsForLayer(HIGHLIGHT, "highlight").map(([f]) => f)).toEqual([
      "color",
      "opacity",
      "blend"
    ]);
    expect(slotFieldsForLayer(HIGHLIGHT, "arrow")).toEqual([["color", "yellow"]]);
  });

  test("blur gives nothing to a colored kind and takes nothing from one", () => {
    expect(slotFieldsForLayer(BLUR, "arrow")).toEqual([]);
    expect(slotFieldsForLayer(RED_ARROW, "blur")).toEqual([]);
    expect(slotFieldsForLayer(BLUR, "blur")).toEqual([
      ["mode", "gaussian"],
      ["radius", { mode: "auto" }]
    ]);
  });
});

describe("bagSlotIndexForCode", () => {
  test("reads the physical digit row and the numpad, so Shift does not change the slot", () => {
    expect(bagSlotIndexForCode("Digit1")).toBe(0);
    expect(bagSlotIndexForCode("Digit9")).toBe(8);
    expect(bagSlotIndexForCode("Numpad4")).toBe(3);
  });

  test("ignores 0 and everything else", () => {
    expect(bagSlotIndexForCode("Digit0")).toBeNull();
    expect(bagSlotIndexForCode("KeyA")).toBeNull();
    expect(bagSlotIndexForCode("Digit10")).toBeNull();
  });
});

describe("styleValuesEqual", () => {
  test("compares nested values structurally", () => {
    expect(styleValuesEqual({ mode: "px", value: 4 }, { mode: "px", value: 4 })).toBe(true);
    expect(styleValuesEqual({ mode: "px", value: 4 }, { mode: "px", value: 5 })).toBe(false);
  });

  test("a missing key is a difference", () => {
    expect(styleValuesEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});
