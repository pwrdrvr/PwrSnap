// Tests for `buildLayerContextMenuItems` — the pure function that
// produces the right-click context menu's item list from the
// current selection. Covers the enable/disable matrix in issue #134
// §"Selection-state-aware":
//   • z-order ops: disabled when nothing selected
//   • Cut / Copy / Duplicate / Delete: enabled when ≥1 selected
//   • Paste: always enabled (no cheap OS-clipboard probe)
//   • Edit Text: enabled only on single text selection
//
// Plus the "Edit Text appears at the top of the menu when relevant"
// affordance check — the row order matters for UX (the most
// contextually-specific item leads).

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import {
  buildLayerContextMenuItems,
  type LayerContextMenuItem,
  type LayerContextMenuItemId
} from "../buildLayerContextMenuItems";

function row(id: string, data: OverlayRow["data"]): OverlayRow {
  return {
    id,
    capture_id: "cap-1",
    data,
    schema_version: 1,
    created_at: "2026-05-28T00:00:00.000Z",
    applied_at: null,
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

const arrowRow = (id: string): OverlayRow =>
  row(id, {
    kind: "arrow",
    from: { x: 0.1, y: 0.5 },
    to: { x: 0.9, y: 0.5 },
    color: "auto"
  });

const textRow = (id: string): OverlayRow =>
  row(id, {
    kind: "text",
    point: { x: 0.5, y: 0.5 },
    body: "hi",
    size: "medium",
    color: "auto"
  });

const rectRow = (id: string): OverlayRow =>
  row(id, {
    kind: "rect",
    rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
    color: "auto"
  });

/** Helper — fetch the item with a given id, asserting that it
 *  exists (separators are skipped). Throws on miss so the test
 *  failures point at the right item rather than a chain of
 *  undefined-access errors. */
function findItem(
  items: readonly LayerContextMenuItem[],
  id: LayerContextMenuItemId
): LayerContextMenuItem {
  // Skip separators when matching by id — they all share the same
  // sentinel id but are flagged via `isSeparator`.
  const hit = items.find(
    (item) => item.id === id && item.isSeparator !== true
  );
  if (hit === undefined) {
    throw new Error(
      `expected item with id="${id}", got: ${JSON.stringify(items.filter((i) => i.isSeparator !== true).map((i) => i.id))}`
    );
  }
  return hit;
}

describe("buildLayerContextMenuItems — empty selection", () => {
  const overlays = [arrowRow("a"), rectRow("r")];
  const items = buildLayerContextMenuItems({
    selectedLayerIds: [],
    overlays
  });

  test("emits no Edit Text row when nothing is selected", () => {
    expect(items.find((i) => i.id === "edit-text" && i.isSeparator !== true)).toBeUndefined();
  });

  test("Cut / Copy / Duplicate / Delete disabled when no selection", () => {
    expect(findItem(items, "cut").enabled).toBe(false);
    expect(findItem(items, "copy").enabled).toBe(false);
    expect(findItem(items, "duplicate").enabled).toBe(false);
    expect(findItem(items, "delete").enabled).toBe(false);
  });

  test("Paste enabled even with no selection (paste-from-OS lives independently)", () => {
    expect(findItem(items, "paste").enabled).toBe(true);
  });

  test("Z-order ops disabled when no selection", () => {
    expect(findItem(items, "bring-to-front").enabled).toBe(false);
    expect(findItem(items, "bring-forward").enabled).toBe(false);
    expect(findItem(items, "send-backward").enabled).toBe(false);
    expect(findItem(items, "send-to-back").enabled).toBe(false);
  });
});

describe("buildLayerContextMenuItems — single non-text selection", () => {
  const overlays = [arrowRow("a1"), rectRow("r1")];
  const items = buildLayerContextMenuItems({
    selectedLayerIds: ["a1"],
    overlays
  });

  test("no Edit Text row when single non-text selected", () => {
    expect(items.find((i) => i.id === "edit-text" && i.isSeparator !== true)).toBeUndefined();
  });

  test("Cut / Copy / Duplicate / Delete enabled with a selection", () => {
    expect(findItem(items, "cut").enabled).toBe(true);
    expect(findItem(items, "copy").enabled).toBe(true);
    expect(findItem(items, "duplicate").enabled).toBe(true);
    expect(findItem(items, "delete").enabled).toBe(true);
  });

  test("Z-order ops enabled with a selection", () => {
    expect(findItem(items, "bring-to-front").enabled).toBe(true);
    expect(findItem(items, "bring-forward").enabled).toBe(true);
    expect(findItem(items, "send-backward").enabled).toBe(true);
    expect(findItem(items, "send-to-back").enabled).toBe(true);
  });
});

describe("buildLayerContextMenuItems — single text selection", () => {
  const overlays = [textRow("t1"), arrowRow("a1")];
  const items = buildLayerContextMenuItems({
    selectedLayerIds: ["t1"],
    overlays
  });

  test("Edit Text row IS emitted and enabled", () => {
    const editText = findItem(items, "edit-text");
    expect(editText.enabled).toBe(true);
  });

  test("Edit Text appears as the FIRST item (most contextually-specific leads)", () => {
    // Skip leading separators (none expected at index 0 but the
    // assertion is robust).
    const firstNonSeparator = items.find((i) => i.isSeparator !== true);
    expect(firstNonSeparator?.id).toBe("edit-text");
  });

  test("clipboard + z-order ops also enabled (Edit Text is additive)", () => {
    expect(findItem(items, "copy").enabled).toBe(true);
    expect(findItem(items, "bring-to-front").enabled).toBe(true);
    expect(findItem(items, "delete").enabled).toBe(true);
  });
});

describe("buildLayerContextMenuItems — multi-selection", () => {
  const overlays = [textRow("t1"), arrowRow("a1"), rectRow("r1")];
  const items = buildLayerContextMenuItems({
    selectedLayerIds: ["t1", "a1"],
    overlays
  });

  test("no Edit Text row in multi-selection even when one is text", () => {
    // Edit Text only makes sense for a SINGLE text overlay — when
    // multiple things are selected the user means "act on the
    // group", not "edit this one text body".
    expect(items.find((i) => i.id === "edit-text" && i.isSeparator !== true)).toBeUndefined();
  });

  test("Cut / Copy / Duplicate / Delete enabled in multi-selection", () => {
    expect(findItem(items, "cut").enabled).toBe(true);
    expect(findItem(items, "copy").enabled).toBe(true);
    expect(findItem(items, "duplicate").enabled).toBe(true);
    expect(findItem(items, "delete").enabled).toBe(true);
  });

  test("Z-order ops enabled in multi-selection", () => {
    expect(findItem(items, "bring-to-front").enabled).toBe(true);
    expect(findItem(items, "bring-forward").enabled).toBe(true);
    expect(findItem(items, "send-backward").enabled).toBe(true);
    expect(findItem(items, "send-to-back").enabled).toBe(true);
  });
});

describe("buildLayerContextMenuItems — accelerator labels present on every action row", () => {
  const overlays = [textRow("t1")];
  const items = buildLayerContextMenuItems({
    selectedLayerIds: ["t1"],
    overlays
  });
  const actionRows = items.filter((i) => i.isSeparator !== true);

  test("every action row has a non-empty accelerator", () => {
    for (const item of actionRows) {
      expect(item.accel, `accel for ${item.id}`).not.toBe("");
    }
  });

  test("accelerators are the expected glyph strings", () => {
    expect(findItem(items, "copy").accel).toBe("⌘C");
    expect(findItem(items, "paste").accel).toBe("⌘V");
    expect(findItem(items, "duplicate").accel).toBe("⌘D");
    expect(findItem(items, "delete").accel).toBe("⌫");
    expect(findItem(items, "bring-to-front").accel).toBe("⌘⇧]");
    expect(findItem(items, "send-to-back").accel).toBe("⌘⇧[");
  });
});

describe("buildLayerContextMenuItems — separators between groups", () => {
  // The menu has three structural groups: (Edit Text) / clipboard /
  // z-order / destructive. Separators are interleaved so the
  // renderer can paint thin dividers between groups. This is a
  // light contract test — we don't lock the exact count beyond
  // "at least one separator in a menu with ≥1 selected" because
  // future row additions might add groups.
  test("renders separators when selection is non-empty", () => {
    const items = buildLayerContextMenuItems({
      selectedLayerIds: ["t1"],
      overlays: [textRow("t1")]
    });
    expect(items.some((i) => i.isSeparator === true)).toBe(true);
  });

  test("renders separators even on empty selection (between groups)", () => {
    const items = buildLayerContextMenuItems({
      selectedLayerIds: [],
      overlays: []
    });
    // Without Edit Text, still expect at least one separator
    // between clipboard / z-order / destructive groups.
    expect(items.some((i) => i.isSeparator === true)).toBe(true);
  });
});
