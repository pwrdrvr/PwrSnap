import { describe, expect, test } from "vitest";
import {
  defaultEditorToolBag,
  readShapeStrokeStyle,
  type OverlayRow,
  type ToolBagSlot
} from "@pwrsnap/shared";
import { layerStyleUpdate } from "../Editor";
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

type ArrowSlotStyle = Extract<ToolBagSlot, { tool: "arrow" }>["style"];
type ShapeSlotStyle = Extract<ToolBagSlot, { tool: "shape" }>["style"];

function arrowSlot(patch: Partial<ArrowSlotStyle>): ToolBagSlot {
  return { tool: "arrow", style: { ...(RED_ARROW.style as ArrowSlotStyle), ...patch } };
}

function shapeSlot(patch: Partial<ShapeSlotStyle>): ToolBagSlot {
  return { tool: "shape", style: { ...(RED_BOX.style as ShapeSlotStyle), ...patch } };
}

describe("slotFieldsForLayer — the ⇧1–9 paste", () => {
  test("an arrow slot restyles a box without giving it arrow heads", () => {
    expect(slotFieldsForLayer(YELLOW_RANGE, "shape")).toEqual([
      ["color", "yellow"],
      ["thickness", "small"],
      ["strokeStyle", "solid"],
      ["outline", "auto"]
    ]);
  });

  test("an arrow slot onto an arrow carries every head field, so a range makes a double-ended arrow a range", () => {
    expect(slotFieldsForLayer(YELLOW_RANGE, "arrow")).toEqual([
      ["color", "yellow"],
      ["thickness", "small"],
      ["stemStyle", "solid"],
      ["outline", "auto"],
      ["endStyle", "bar"],
      ["doubleEnded", true]
    ]);
  });

  test("a single-ended slot turns a double-ended arrow single-ended", () => {
    const fields = slotFieldsForLayer(RED_ARROW, "arrow");
    expect(fields).toContainEqual(["doubleEnded", false]);
  });

  test("a box slot keeps the target's geometric kind — it never sends `shape`", () => {
    const fields = slotFieldsForLayer(RED_BOX, "shape");
    expect(fields.map(([field]) => field)).toEqual([
      "color",
      "thickness",
      "strokeStyle",
      "outline",
      "filled"
    ]);
  });

  describe("the dash pattern crosses kinds: arrow stemStyle ⇄ shape strokeStyle", () => {
    test("a dashed arrow slot makes a box dashed", () => {
      expect(slotFieldsForLayer(arrowSlot({ stemStyle: "dashed" }), "shape")).toContainEqual([
        "strokeStyle",
        "dashed"
      ]);
    });

    test("a solid arrow slot makes a dashed box solid again", () => {
      const fields = slotFieldsForLayer(arrowSlot({ stemStyle: "solid" }), "shape");
      expect(fields).toContainEqual(["strokeStyle", "solid"]);
      // The arrow-side name never reaches a shape — the generic write
      // path would persist it as a dead field on the row.
      expect(fields.map(([field]) => field)).not.toContain("stemStyle");
    });

    test("a dotted box slot makes an arrow's stem dotted", () => {
      const fields = slotFieldsForLayer(shapeSlot({ strokeStyle: "dotted" }), "arrow");
      expect(fields).toContainEqual(["stemStyle", "dotted"]);
      expect(fields.map(([field]) => field)).not.toContain("strokeStyle");
    });

    test("box onto box and arrow onto arrow carry it under their own names", () => {
      expect(slotFieldsForLayer(shapeSlot({ strokeStyle: "dashed" }), "shape")).toContainEqual([
        "strokeStyle",
        "dashed"
      ]);
      expect(slotFieldsForLayer(arrowSlot({ stemStyle: "dotted" }), "arrow")).toContainEqual([
        "stemStyle",
        "dotted"
      ]);
    });

    test("through the real write path, a dashed arrow slot leaves a legacy box dashed and undoable", () => {
      const row: OverlayRow = {
        id: "ly_box",
        capture_id: "cap_1",
        data: { kind: "shape", shape: "rect", rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, color: "#ff5a5a" },
        schema_version: 1,
        source: "user",
        ai_run_id: null,
        z_index: 1000,
        rejected_at: null,
        applied_at: "2026-09-30T00:00:00.000Z",
        superseded_by: null,
        created_at: "2026-09-30T00:00:00.000Z"
      };
      const dims = { sourceWidthPx: 1600, sourceHeightPx: 900, canvasWidthPx: 1600, canvasHeightPx: 900 };
      let data = row.data;
      for (const [field, value] of slotFieldsForLayer(arrowSlot({ stemStyle: "dashed" }), "shape")) {
        const update = layerStyleUpdate({ ...row, data }, field, value, dims);
        if (update === null) continue;
        if (field === "strokeStyle") {
          // Undo restores the field-ABSENT legacy state, not "solid".
          expect(update.fallbackPreviousPatch).toEqual({ kind: "shape", strokeStyle: undefined });
        }
        data = { ...data, ...update.patch } as typeof data;
      }
      expect(data.kind).toBe("shape");
      if (data.kind !== "shape") return;
      expect(readShapeStrokeStyle(data)).toBe("dashed");
      expect(data).not.toHaveProperty("stemStyle");
      expect(data.shape).toBe("rect");
    });

    test("text and highlight neither give nor take it", () => {
      const dashed = arrowSlot({ stemStyle: "dashed" });
      for (const target of ["text", "highlight"] as const) {
        const names = slotFieldsForLayer(dashed, target).map(([field]) => field);
        expect(names).not.toContain("stemStyle");
        expect(names).not.toContain("strokeStyle");
      }
      for (const source of [RED_TEXT, HIGHLIGHT]) {
        for (const target of ["arrow", "shape"] as const) {
          const names = slotFieldsForLayer(source, target).map(([field]) => field);
          expect(names).not.toContain("stemStyle");
          expect(names).not.toContain("strokeStyle");
        }
      }
    });
  });

  test("text takes color and border, never stroke thickness; a striped border becomes Auto", () => {
    const striped = arrowSlot({ outline: "stripe" });
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
