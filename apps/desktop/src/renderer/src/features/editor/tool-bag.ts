// Tool bag — nine saved, complete tool styles on keys 1–9.
//
// Two gestures read a slot, and they mean different things:
//
//   • 1–9 (or a click) ARMS the slot: the slot's tool becomes active and
//     its whole style becomes that tool's working style. The next drag
//     draws with it.
//   • ⇧1–9 (or a ⇧-click) PASTES the slot onto the selection, the way
//     Factorio's copy/paste-settings works: whatever the slot says that
//     the selected layer can carry, it takes; the rest of the layer is
//     left alone. A green arrow slot turns a selected red box green and
//     keeps it a box. A yellow single-ended arrow slot turns a selected
//     double-ended arrow yellow AND single-ended.
//
// The paste mapping lives here, as a pure function, so the rules are
// testable without an editor. `slotFieldsForLayer` answers "which style
// fields, with which values" in the same field vocabulary
// `layerStyleUpdate` (Editor.tsx) already speaks, so the write goes
// through the exact persistence + undo path the Properties controls use.

import type {
  OverlayOutlineMode,
  ToolBagSlot
} from "@pwrsnap/shared";

/** Tool families a placed layer can project to (see
 *  `styledLayerStyle`). */
export type PasteTargetTool = "arrow" | "text" | "shape" | "blur" | "highlight" | "draw";

export type SlotStyleField = readonly [field: string, value: unknown];

/**
 * The bag slot a (tool, style) pair saves as, or `null` when it cannot be
 * saved: the Draw tool in eraser mode. The eraser is a way of using the
 * tool, not a style the next drag draws with, so settings refuse an
 * eraser slot and nothing offers to save one.
 *
 * The pair must come from one discriminated source (a layer projection
 * or the tool state); the cast only restates what the caller holds.
 */
export function bagSlotForStyle(tool: ToolBagSlot["tool"], style: unknown): ToolBagSlot | null {
  if (tool === "draw" && (style as { mode?: unknown } | null)?.mode === "eraser") return null;
  return { tool, style } as ToolBagSlot;
}

/** Text renders no stripe (illegible at glyph stroke widths). Pasting a
 *  striped arrow onto a label gives it the contrast mode instead of a
 *  value the text renderer would silently coerce. */
function outlineForText(mode: OverlayOutlineMode): OverlayOutlineMode {
  return mode === "stripe" ? "auto" : mode;
}

/**
 * The style fields a slot contributes to a layer of kind `target`.
 *
 * Rules, all "keep what the target can't express":
 *   • color — every colored kind (arrow, shape, text, highlight, draw)
 *     takes the slot's color. Blur has no color and gives none.
 *   • thickness — shared by arrows, shapes and Draw strokes (the same
 *     stroke ladder).
 *   • outline — shared by arrows, shapes and text.
 *   • dash pattern — shared by arrows and shapes, under two names: an
 *     arrow's `stemStyle` IS a shape's `strokeStyle` (same solid /
 *     dashed / dotted value space). A dashed arrow slot pasted onto a
 *     box makes the box dashed, and a dotted box slot pasted onto an
 *     arrow makes its stem dotted.
 *   • arrow heads (endStyle, doubleEnded) — arrow → arrow.
 *   • fill — shape → shape. The target keeps its geometric kind: a paste
 *     restyles a circle, it never turns it into the slot's rectangle.
 *   • text size + weight — text → text.
 *   • opacity + blend — highlight → highlight.
 *   • draw mode (pen / marker / spray) — draw → draw. A pen slot pasted
 *     onto a marker stroke makes it a pen stroke along the same path.
 *   • blur mode + radius — blur → blur, and blur takes nothing else.
 *
 * Returns an empty list when nothing applies (a blur slot pasted onto an
 * arrow).
 */
export function slotFieldsForLayer(
  slot: ToolBagSlot,
  target: PasteTargetTool
): SlotStyleField[] {
  const fields: SlotStyleField[] = [];

  if (slot.tool === "blur") {
    if (target === "blur") {
      fields.push(["mode", slot.style.mode], ["radius", slot.style.radius]);
    }
    return fields;
  }
  if (target === "blur") return fields;

  fields.push(["color", slot.style.color]);

  if (
    (slot.tool === "arrow" || slot.tool === "shape" || slot.tool === "draw") &&
    (target === "arrow" || target === "shape" || target === "draw")
  ) {
    fields.push(["thickness", slot.style.thickness]);
    const dash = slot.tool === "arrow" ? slot.style.stemStyle : slot.style.strokeStyle;
    fields.push([target === "arrow" ? "stemStyle" : "strokeStyle", dash]);
  }

  if (
    (slot.tool === "arrow" || slot.tool === "shape" || slot.tool === "text") &&
    (target === "arrow" || target === "shape" || target === "text")
  ) {
    fields.push([
      "outline",
      target === "text" ? outlineForText(slot.style.outline) : slot.style.outline
    ]);
  }

  if (slot.tool === "arrow" && target === "arrow") {
    fields.push(
      ["endStyle", slot.style.endStyle],
      ["doubleEnded", slot.style.doubleEnded]
    );
  }
  if (slot.tool === "shape" && target === "shape") {
    fields.push(["filled", slot.style.filled]);
  }
  if (slot.tool === "text" && target === "text") {
    fields.push(["fontSize", slot.style.fontSize], ["weight", slot.style.weight]);
  }
  if (slot.tool === "highlight" && target === "highlight") {
    fields.push(["opacity", slot.style.opacity], ["blend", slot.style.blend]);
  }
  // A slot never holds the eraser (settings refuse it), but a hand-edited
  // file could; an eraser is not a stroke style, so it pastes no mode.
  if (slot.tool === "draw" && target === "draw" && slot.style.mode !== "eraser") {
    fields.push(["mode", slot.style.mode]);
  }
  return fields;
}

/** Structural equality over tool-style values (flat objects whose only
 *  nested value is blur's `radius`). Used to tell whether the armed
 *  slot's style has been edited since it was armed. */
export function styleValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    styleValuesEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k]
    )
  );
}

/** Key → slot index for the bag shortcuts. Reads `event.code`, not
 *  `event.key`: with Shift held, `key` is "!" / "@" / … and depends on
 *  the keyboard layout, while `code` is the physical digit row. The
 *  numpad counts too. Returns null for anything else. */
export function bagSlotIndexForCode(code: string): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return match === null ? null : Number(match[1]) - 1;
}
