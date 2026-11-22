// A capture SET: the selector's third output shape ("Separate"). One
// shutter press over N picks saves N ordinary captures, one per picked
// window or display, instead of one union box that is transparent
// between the picks.
//
// This is the pure half: which pixels each item is cut from, which
// display it is filed under, and which single item (if any) carries the
// cursor. The capture handler does the I/O around it.
//
// Each item is planned exactly the way a LONE pick of the same rect is:
// an item that lies on one display needs that display's snapshot and no
// other, so it takes the plain single-snapshot crop and comes out
// byte-identical to picking that window alone. Only a window that
// straddles two displays reaches for a second snapshot.

import {
  displaysTouched,
  homeDisplayFor,
  type DisplayGeometry,
  type LogicalRect
} from "./multi-display-selection";

/** One pick in GLOBAL logical px, in pick order. */
export type CaptureSetPick = {
  rect: LogicalRect;
  /** The native window id, or null for a whole-display pick. */
  windowId: number | null;
};

export type CaptureSetItem = {
  /** Position in the user's pick order (0-based). Items keep it even
   *  when an earlier pick is dropped, so logs can name the pick. */
  pickIndex: number;
  rect: LogicalRect;
  windowId: number | null;
  /** The display the item is filed under (its snapshot is the crop's
   *  primary source; its scale factor is the item's density unless the
   *  item straddles a sharper display). */
  displayId: number;
  /** Other displays this item's pixels come from — non-empty only for a
   *  pick straddling a display seam. */
  extraDisplayIds: number[];
  /** True on at most one item: the first, in pick order, whose rect
   *  holds the pointer. Overlapping picks never both draw it. */
  cursor: boolean;
};

function containsPoint(rect: LogicalRect, p: { x: number; y: number }): boolean {
  // Inclusive edges — the same test the single-capture path uses to
  // decide whether the pointer sits in a kept extent.
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

/**
 * Plan a set: one item per pick that some captured display shows.
 *
 * A pick no snapshotted display overlaps is dropped (it has no pixels to
 * cut); every other pick yields exactly one item, in pick order. Ties
 * between displays holding equal shares of a straddling pick go to
 * `preferDisplayId` (the display the user committed from), then the
 * lowest id — the same rule the union commit files under.
 */
export function planCaptureSet(args: {
  picks: readonly CaptureSetPick[];
  displays: readonly DisplayGeometry[];
  /** Displays that have a frozen snapshot this commit may draw from. */
  snapshotDisplayIds: ReadonlySet<number>;
  preferDisplayId: number;
  /** The pointer in GLOBAL logical px, or null when no cursor is drawn. */
  cursor: { x: number; y: number } | null;
}): CaptureSetItem[] {
  const usable = args.displays.filter((d) => args.snapshotDisplayIds.has(d.id));
  const items: CaptureSetItem[] = [];
  let cursorTaken = false;
  args.picks.forEach((pick, pickIndex) => {
    const r = pick.rect;
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0) return;
    const touched = displaysTouched([r], usable);
    if (touched.length === 0) return;
    const home = homeDisplayFor(r, usable, args.preferDisplayId) ?? touched[0]!;
    const cursor = !cursorTaken && args.cursor !== null && containsPoint(r, args.cursor);
    if (cursor) cursorTaken = true;
    items.push({
      pickIndex,
      rect: { ...r },
      windowId: pick.windowId,
      displayId: home,
      extraDisplayIds: touched.filter((id) => id !== home),
      cursor
    });
  });
  return items;
}

/** Pair each extent with the window id the renderer reported for it.
 *  Missing, negative (whole-display) or non-integer ids become null. */
export function captureSetPicks(
  extents: readonly LogicalRect[],
  windowIds: readonly (number | null)[] | undefined
): CaptureSetPick[] {
  return extents.map((rect, i) => {
    const id = windowIds?.[i];
    return {
      rect,
      windowId: typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : null
    };
  });
}
