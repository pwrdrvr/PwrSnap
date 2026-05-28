// Z-order algorithms for the editor's bring-forward / send-backward /
// bring-to-front / send-to-back keyboard shortcuts. Pure functions —
// no React, no IPC — so they're easy to unit-test in isolation.
//
// Input contract: `items` is already sorted by current z_index ASC
// (which is what `useCaptureModel` returns, since `overlays-repo.ts`
// reads `ORDER BY z_index ASC, created_at ASC` and the v2 layer-tree
// projection mirrors that). Position 0 paints first (bottom of stack);
// position N-1 paints last (top of stack).
//
// Output: a `readonly Change[]` listing the layer ids whose z_index
// the caller should re-assign, together with the new value. Items not
// in the list keep their existing z_index. We assign new values as
// `newPosition × Z_GAP` so the contiguous slots have plenty of room
// between them for future inserts without a re-numbering pass.
//
// Multi-select semantics:
//   • forward / backward: each selected item moves ONE step over a
//     non-selected neighbor. Adjacent selected items move as a group
//     (they don't swap with each other). Hits the wall when no
//     non-selected neighbor exists on that side.
//   • toFront / toBack: every selected item moves to the very front /
//     back as a contiguous block, preserving their relative order
//     among themselves.

/** Caller-facing item shape — just enough for the algorithms to do
 *  their work. The renderer uses OverlayRow but we strip to id-only
 *  here so the helpers are agnostic to the v1/v2 row shape. */
export interface ZOrderItem {
  id: string;
}

/** One z_index re-assignment that the caller should dispatch. */
export interface ZOrderChange {
  id: string;
  newZIndex: number;
}

/** Gap between contiguous positions in the new z_index space. Layers
 *  inserted between two existing layers in the future can take a value
 *  in the middle of this gap without forcing every neighbor to renumber.
 *  1000 is the same gap convention as the v2 layers-repo. */
export const Z_GAP = 1000;

/** Compute the new ordering of `items` after applying `variant` to the
 *  subset whose ids are in `selectedIds`. Returns the freshly-ordered
 *  array, NOT a list of changes — convert to changes via `diffChanges`
 *  below.
 *
 *  Visible-position semantics: position 0 = bottom of stack (paints
 *  first), position N-1 = top of stack (paints last). "Forward" /
 *  "to front" move items toward N-1; "backward" / "to back" toward 0.
 */
export function computeNewOrder<T extends ZOrderItem>(
  items: readonly T[],
  selectedIds: readonly string[],
  variant: "forward" | "backward" | "toFront" | "toBack"
): readonly T[] {
  const sel = new Set(selectedIds);
  if (sel.size === 0) return items;
  switch (variant) {
    case "forward":
      return bringForward(items, sel);
    case "backward":
      return sendBackward(items, sel);
    case "toFront":
      return bringToFront(items, sel);
    case "toBack":
      return sendToBack(items, sel);
  }
}

/** Diff the new ordering against the old, producing one ZOrderChange
 *  per item whose POSITION moved. Items that didn't move keep their
 *  current z_index — the renderer only dispatches reorder for the
 *  ones in the result. */
export function diffChanges<T extends ZOrderItem>(
  oldOrder: readonly T[],
  newOrder: readonly T[]
): readonly ZOrderChange[] {
  const oldPos = new Map<string, number>();
  oldOrder.forEach((item, i) => oldPos.set(item.id, i));
  const changes: ZOrderChange[] = [];
  newOrder.forEach((item, newIdx) => {
    const prev = oldPos.get(item.id);
    if (prev === undefined || prev !== newIdx) {
      changes.push({ id: item.id, newZIndex: newIdx * Z_GAP });
    }
  });
  return changes;
}

/** Bring forward (one step). Walk from top-1 down to 0. For each
 *  selected item, swap with the item above (index+1) only if that
 *  neighbor is NOT also selected — so a contiguous block of selected
 *  items moves up as a group rather than internally re-shuffling. */
function bringForward<T extends ZOrderItem>(
  items: readonly T[],
  sel: ReadonlySet<string>
): readonly T[] {
  const out = items.slice();
  for (let i = out.length - 2; i >= 0; i -= 1) {
    const here = out[i];
    const above = out[i + 1];
    if (here !== undefined && above !== undefined && sel.has(here.id) && !sel.has(above.id)) {
      out[i] = above;
      out[i + 1] = here;
    }
  }
  return out;
}

/** Send backward (one step). Mirror of bringForward — walk from index
 *  1 up to top; swap each selected item with the item BELOW if that
 *  neighbor isn't also selected. */
function sendBackward<T extends ZOrderItem>(
  items: readonly T[],
  sel: ReadonlySet<string>
): readonly T[] {
  const out = items.slice();
  for (let i = 1; i < out.length; i += 1) {
    const here = out[i];
    const below = out[i - 1];
    if (here !== undefined && below !== undefined && sel.has(here.id) && !sel.has(below.id)) {
      out[i] = below;
      out[i - 1] = here;
    }
  }
  return out;
}

/** Bring to front. Partition into non-selected first, then selected
 *  — both groups preserve their internal order. */
function bringToFront<T extends ZOrderItem>(
  items: readonly T[],
  sel: ReadonlySet<string>
): readonly T[] {
  const unsel: T[] = [];
  const selected: T[] = [];
  for (const item of items) {
    if (sel.has(item.id)) selected.push(item);
    else unsel.push(item);
  }
  return [...unsel, ...selected];
}

/** Send to back. Selected first, then non-selected. */
function sendToBack<T extends ZOrderItem>(
  items: readonly T[],
  sel: ReadonlySet<string>
): readonly T[] {
  const unsel: T[] = [];
  const selected: T[] = [];
  for (const item of items) {
    if (sel.has(item.id)) selected.push(item);
    else unsel.push(item);
  }
  return [...selected, ...unsel];
}
