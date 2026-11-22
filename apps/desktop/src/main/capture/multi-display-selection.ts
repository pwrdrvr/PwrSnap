// Geometry for a selector session that spans more than one display.
//
// The picker shows one frozen snapshot per display, each in its own
// selector window. A selection is still expressed the way a
// single-display pick always was — a union `rect` plus optional
// `extents`, in GLOBAL logical px — but those rectangles may now cross
// display boundaries, and the picks that make them up may have been
// made on different displays.
//
// This module is the pure half of that:
//   - `mergeSessionPicks` folds every display's picks into one ordered,
//     de-duplicated set (a window that straddles two displays is listed
//     by both selectors, and must be captured once);
//   - `planSessionCommit` turns a renderer's commit plus the session's
//     picks into the selection main hands the capture handler, and says
//     which displays' snapshots the crop needs;
//   - `planMultiDisplayComposite` maps that selection onto N snapshots
//     with different origins and scale factors and one output canvas.
//
// Nothing here touches Electron, sharp, or the filesystem, so the
// arithmetic — where the seams, gaps and off-by-ones live — can be
// property-tested directly.

export type LogicalRect = { x: number; y: number; w: number; h: number };

/** What a multi-pick commit produces:
 *  - `windows`   — one image, the union box, transparent outside the picks;
 *  - `rectangle` — one image, the whole union box opaque;
 *  - `set`       — one capture per pick (see capture-set.ts). */
export type SelectorOutputMode = "windows" | "rectangle" | "set";

export type DisplayGeometry = {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
};

/** One pick in GLOBAL logical px. `key` de-duplicates across displays:
 *  `w:<windowId>` for a window, `d:<displayId>` for a whole display. */
export type SessionPick = {
  key: string;
  /** The native window id, or null for a whole-display pick. */
  windowId: number | null;
  rect: LogicalRect;
};

/** Renderer pick ids below zero are whole-display picks. Real native
 *  window ids are never negative on any platform we ship. */
export function sessionPickKey(id: number, displayId: number): string {
  return id < 0 ? `d:${displayId}` : `w:${id}`;
}

export function sessionPickFromRenderer(
  id: number,
  localRect: LogicalRect,
  display: { id: number; bounds: { x: number; y: number } }
): SessionPick {
  return {
    key: sessionPickKey(id, display.id),
    windowId: id < 0 ? null : id,
    rect: {
      x: localRect.x + display.bounds.x,
      y: localRect.y + display.bounds.y,
      w: localRect.w,
      h: localRect.h
    }
  };
}

export function displayRect(display: DisplayGeometry): LogicalRect {
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    w: display.bounds.width,
    h: display.bounds.height
  };
}

export function intersectRects(a: LogicalRect, b: LogicalRect): LogicalRect | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Whether `p` lies in `r`, edges included. The one rule every cursor
 *  placement decision uses: a pointer exactly on a kept edge is kept. */
export function rectContainsPoint(r: LogicalRect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function unionRects(rects: readonly LogicalRect[]): LogicalRect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function area(r: LogicalRect | null): number {
  return r === null ? 0 : r.w * r.h;
}

/**
 * Every display's picks as one ordered set, each key once.
 *
 * Order is the order the user picked in (`order`, the session's
 * first-seen sequence of keys); keys `order` does not know yet go last
 * in display order. The first pick names the capture's source app, so
 * the order is not cosmetic.
 *
 * A key listed by two displays (a window straddling them) keeps the
 * FIRST display's rect. Both selectors received the same global window
 * bounds, so the two rects are the same rectangle anyway.
 */
export function mergeSessionPicks(
  picksByDisplay: ReadonlyMap<number, readonly SessionPick[]>,
  order: readonly string[]
): SessionPick[] {
  const byKey = new Map<string, SessionPick>();
  for (const picks of picksByDisplay.values()) {
    for (const pick of picks) {
      if (!byKey.has(pick.key)) byKey.set(pick.key, pick);
    }
  }
  const merged: SessionPick[] = [];
  for (const key of order) {
    const pick = byKey.get(key);
    if (pick === undefined) continue;
    merged.push(pick);
    byKey.delete(key);
  }
  for (const pick of byKey.values()) merged.push(pick);
  return merged;
}

/** Displays that a selection actually draws pixels from. */
export function displaysTouched(
  rects: readonly LogicalRect[],
  displays: readonly DisplayGeometry[]
): number[] {
  return displays
    .filter((d) => rects.some((r) => intersectRects(r, displayRect(d)) !== null))
    .map((d) => d.id);
}

/**
 * The display a cross-display selection is filed under: the one holding
 * the most of `rect`. Ties go to `prefer` (the display the user committed
 * from), then to the lowest id, so the answer never depends on the order
 * `screen.getAllDisplays()` happens to return.
 */
export function homeDisplayFor(
  rect: LogicalRect,
  displays: readonly DisplayGeometry[],
  prefer: number
): number | null {
  let best: { id: number; area: number } | null = null;
  for (const d of displays) {
    const a = area(intersectRects(rect, displayRect(d)));
    if (a <= 0) continue;
    if (
      best === null ||
      a > best.area ||
      (a === best.area && (d.id === prefer || (best.id !== prefer && d.id < best.id)))
    ) {
      best = { id: d.id, area: a };
    }
  }
  return best?.id ?? null;
}

export type SessionCommitInput = {
  /** The display whose selector sent the commit. */
  committingDisplayId: number;
  /** The renderer's selection, already translated to GLOBAL logical px. */
  rect: LogicalRect;
  extents?: readonly LogicalRect[];
  /** The native window id behind each extent (null = a whole-display
   *  pick), index-aligned with `extents`, when the renderer sent them. */
  extentWindowIds?: readonly (number | null)[];
  outputMode?: SelectorOutputMode;
  snappedWindowId?: number;
  /** True when the renderer asked main to fold in the picks made on the
   *  OTHER displays (it had some on screen). Its own picks arrive in
   *  `localPicks`. */
  mergePeers: boolean;
  localPicks: readonly SessionPick[];
  /** Picks last reported by every OTHER display. */
  peerPicks: ReadonlyMap<number, readonly SessionPick[]>;
  pickOrder: readonly string[];
  sessionOutputMode: SelectorOutputMode;
  displays: readonly DisplayGeometry[];
  /** Displays that have a frozen snapshot this commit may draw from. */
  snapshotDisplayIds: ReadonlySet<number>;
};

export type SessionCommitPlan = {
  rect: LogicalRect;
  extents?: LogicalRect[];
  /** Index-aligned with `extents`; present whenever the window ids are
   *  known (always after a merge). A `set` capture names each item's
   *  source window from it. */
  extentWindowIds?: (number | null)[];
  outputMode?: SelectorOutputMode;
  snappedWindowId?: number;
  /** The display the selection is filed under; its snapshot becomes
   *  `screenSnapshotId`. */
  displayId: number;
  /** Other displays whose snapshots the crop needs, in display order. */
  extraDisplayIds: number[];
};

/**
 * Decide what a commit in a multi-display session captures.
 *
 * Returns null when a merge commit has nothing left to capture (every
 * pick was dropped in the meantime) — the caller treats that as a cancel,
 * exactly as the renderer does for an empty pick set.
 *
 * A commit whose pixels all lie on the committing display comes back
 * with that display and no extras, so the capture handler takes the same
 * single-snapshot path a one-display machine always has.
 */
export function planSessionCommit(input: SessionCommitInput): SessionCommitPlan | null {
  let rect = input.rect;
  let extents: LogicalRect[] | undefined =
    input.extents === undefined || input.extents.length === 0 ? undefined : [...input.extents];
  let outputMode = extents === undefined ? undefined : input.outputMode;
  let extentWindowIds: (number | null)[] | undefined =
    extents !== undefined &&
    input.extentWindowIds !== undefined &&
    input.extentWindowIds.length === extents.length
      ? [...input.extentWindowIds]
      : undefined;
  let snappedWindowId = input.snappedWindowId;

  if (input.mergePeers) {
    const localKeys = new Set(input.localPicks.map((p) => p.key));
    const peers = new Map<number, SessionPick[]>();
    for (const [displayId, picks] of input.peerPicks) {
      if (displayId === input.committingDisplayId) continue;
      peers.set(
        displayId,
        picks.filter((p) => !localKeys.has(p.key))
      );
    }
    const all = new Map<number, readonly SessionPick[]>([
      [input.committingDisplayId, input.localPicks],
      ...peers
    ]);
    const merged = mergeSessionPicks(all, input.pickOrder);
    if (merged.length === 0) return null;
    const union = unionRects(merged.map((p) => p.rect))!;
    rect = union;
    const firstWindow = merged.find((p) => p.windowId !== null);
    snappedWindowId = firstWindow?.windowId ?? undefined;
    if (merged.length === 1) {
      extents = undefined;
      extentWindowIds = undefined;
      outputMode = undefined;
    } else {
      extents = merged.map((p) => p.rect);
      extentWindowIds = merged.map((p) => p.windowId);
      outputMode = input.outputMode ?? input.sessionOutputMode;
    }
  }

  // Which displays' pixels end up in the output. In WINDOWS mode only the
  // extents are kept, so a display the union box merely crosses (the
  // gap between a window on the left monitor and one on the right
  // monitor) contributes nothing and needs no snapshot. A SET keeps
  // exactly the extents too, one capture each.
  const kept = extents !== undefined && outputMode !== "rectangle" ? extents : [rect];
  const touched = displaysTouched(kept, input.displays).filter((id) =>
    input.snapshotDisplayIds.has(id)
  );
  let home: number | null = input.committingDisplayId;
  if (!touched.includes(input.committingDisplayId)) {
    home = homeDisplayFor(
      rect,
      input.displays.filter((d) => input.snapshotDisplayIds.has(d.id)),
      input.committingDisplayId
    );
  }
  if (home === null) home = input.committingDisplayId;
  const extraDisplayIds = touched.filter((id) => id !== home);

  const plan: SessionCommitPlan = { rect, displayId: home, extraDisplayIds };
  if (extents !== undefined) {
    plan.extents = extents;
    plan.outputMode = outputMode ?? "windows";
    if (extentWindowIds !== undefined) plan.extentWindowIds = extentWindowIds;
  }
  if (snappedWindowId !== undefined && snappedWindowId >= 0) {
    plan.snappedWindowId = snappedWindowId;
  }
  return plan;
}

/** A rectangle in pixels, relative to a raster's origin. */
export type PixelBox = { left: number; top: number; width: number; height: number };

export type CompositeSource = {
  displayId: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  /** The snapshot's actual pixel dimensions. */
  snapshot: { width: number; height: number };
};

export type MultiDisplayCompositePlan = {
  /** Output canvas size, in pixels at `scale`. */
  width: number;
  height: number;
  /** Pixels per logical px in the output — the highest scale factor of
   *  any display that contributes, so a mixed 1×/2× selection keeps the
   *  Retina half sharp (the same rule `capture:allScreens` stitches by). */
  scale: number;
  /** One layer per display that overlaps the box: cut `extract` from
   *  that display's snapshot, resize it to `resize`, draw it at
   *  `left`/`top`. Every layer lies inside the canvas. */
  layers: {
    displayId: number;
    extract: PixelBox;
    resize: { width: number; height: number };
    left: number;
    top: number;
  }[];
  /** Kept rectangles in canvas px (WINDOWS mode). null = keep every
   *  composited pixel; the canvas is transparent wherever no display
   *  covers it either way. */
  mask: PixelBox[] | null;
};

/**
 * Plan the crop of a selection that spans several displays' snapshots.
 *
 * Every display's piece is mapped through ONE rule: a logical edge `e`
 * lands on canvas column `round((e - rect.x) * scale)`. Two displays that
 * abut in logical space (one ends at x=1440, the next starts there)
 * therefore abut on the canvas too — rounding each piece's width
 * separately would open or overlap a 1-px seam between monitors.
 *
 * Returns null when there is nothing to render.
 */
export function planMultiDisplayComposite(args: {
  rect: LogicalRect;
  /** WINDOWS-mode extents; omitted (or empty) keeps the whole box. */
  extents?: readonly LogicalRect[];
  sources: readonly CompositeSource[];
}): MultiDisplayCompositePlan | null {
  const { rect, sources } = args;
  for (const n of [rect.x, rect.y, rect.w, rect.h]) {
    if (!Number.isFinite(n)) return null;
  }
  if (rect.w <= 0 || rect.h <= 0) return null;

  const usable = sources.filter(
    (s) =>
      Number.isFinite(s.scaleFactor) &&
      s.scaleFactor > 0 &&
      s.snapshot.width > 0 &&
      s.snapshot.height > 0 &&
      s.bounds.width > 0 &&
      s.bounds.height > 0 &&
      intersectRects(rect, {
        x: s.bounds.x,
        y: s.bounds.y,
        w: s.bounds.width,
        h: s.bounds.height
      }) !== null
  );
  if (usable.length === 0) return null;
  const scale = Math.max(...usable.map((s) => s.scaleFactor));
  const width = Math.round(rect.w * scale);
  const height = Math.round(rect.h * scale);
  if (width <= 0 || height <= 0) return null;

  const canvasX = (x: number): number =>
    Math.min(width, Math.max(0, Math.round((x - rect.x) * scale)));
  const canvasY = (y: number): number =>
    Math.min(height, Math.max(0, Math.round((y - rect.y) * scale)));

  const layers: MultiDisplayCompositePlan["layers"] = [];
  for (const s of usable) {
    const piece = intersectRects(rect, {
      x: s.bounds.x,
      y: s.bounds.y,
      w: s.bounds.width,
      h: s.bounds.height
    })!;
    const sx = (x: number): number =>
      Math.min(s.snapshot.width, Math.max(0, Math.round((x - s.bounds.x) * s.scaleFactor)));
    const sy = (y: number): number =>
      Math.min(s.snapshot.height, Math.max(0, Math.round((y - s.bounds.y) * s.scaleFactor)));
    const ex0 = sx(piece.x);
    const ey0 = sy(piece.y);
    const ex1 = sx(piece.x + piece.w);
    const ey1 = sy(piece.y + piece.h);
    const cx0 = canvasX(piece.x);
    const cy0 = canvasY(piece.y);
    const cx1 = canvasX(piece.x + piece.w);
    const cy1 = canvasY(piece.y + piece.h);
    if (ex1 <= ex0 || ey1 <= ey0 || cx1 <= cx0 || cy1 <= cy0) continue;
    layers.push({
      displayId: s.displayId,
      extract: { left: ex0, top: ey0, width: ex1 - ex0, height: ey1 - ey0 },
      resize: { width: cx1 - cx0, height: cy1 - cy0 },
      left: cx0,
      top: cy0
    });
  }
  if (layers.length === 0) return null;

  let mask: PixelBox[] | null = null;
  if (args.extents !== undefined && args.extents.length > 0) {
    mask = [];
    for (const e of args.extents) {
      const kept = intersectRects(e, rect);
      if (kept === null) continue;
      const x0 = canvasX(kept.x);
      const y0 = canvasY(kept.y);
      const x1 = canvasX(kept.x + kept.w);
      const y1 = canvasY(kept.y + kept.h);
      if (x1 <= x0 || y1 <= y0) continue;
      mask.push({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    }
    if (mask.length === 0) return null;
  }

  return { width, height, scale, layers, mask };
}
