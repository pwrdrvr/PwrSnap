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
export type PasteTargetTool = "arrow" | "text" | "shape" | "blur" | "highlight";

export type SlotStyleField = readonly [field: string, value: unknown];

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
 *   • color — every colored kind (arrow, shape, text, highlight) takes
 *     the slot's color. Blur has no color and gives none.
 *   • thickness — shared by arrows and shapes (the same stroke ladder).
 *   • outline — shared by arrows, shapes and text.
 *   • arrow heads (endStyle, stemStyle, doubleEnded) — arrow → arrow.
 *   • fill — shape → shape. The target keeps its geometric kind: a paste
 *     restyles a circle, it never turns it into the slot's rectangle.
 *   • text size + weight — text → text.
 *   • opacity + blend — highlight → highlight.
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
    (slot.tool === "arrow" || slot.tool === "shape") &&
    (target === "arrow" || target === "shape")
  ) {
    fields.push(["thickness", slot.style.thickness]);
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
      ["stemStyle", slot.style.stemStyle],
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
