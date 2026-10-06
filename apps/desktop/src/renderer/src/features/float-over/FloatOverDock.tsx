// The float-over's screen-edge dock (tabs), and the rail beside an open
// toast. The dock keeps recent snaps regardless of model status; the rail
// is the recent-snaps catalog, with AI glyphs where a run exists or is expected.
// Same thumbnails, same glyphs; see float-over-dock-model.ts for who is
// in each list and why.

import { useEffect, useRef, useState } from "react";
import type { FloatOverDockSide } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import { FoIcon } from "./FoIcons";
import {
  dockItemTitle,
  dockItemStatus,
  type DockItem,
  type DockStatus,
  type RailItem
} from "./float-over-dock-model";
import { ageTickMs, capturedAtMs, formatThumbAge, useNow } from "./float-over-age";

/** Tab geometry. The window is exactly as wide as what shows: the resting
 *  sliver, or the pulled-out tabs while the pointer is over them —
 *  transparent pixels still take clicks, and the screen edge is where
 *  other apps keep their scrollbars. */
export const DOCK_TAB_WIDTH = 84;
export const DOCK_TAB_HEIGHT = 54;
export const DOCK_TAB_GAP = 6;
export const DOCK_MORE_HEIGHT = 26;
export const DOCK_REST_PEEK = 18;
/** Pulled out: every tab shows this much; the one under the pointer all of it. */
export const DOCK_HOVER_PEEK = 72;
/** How long the window stays wide after the pointer leaves, so the tabs
 *  can slide back in before the window is cut down to the sliver. */
const DOCK_COLLAPSE_MS = 200;
/** A press that moves less than this is a click, not a drag. */
const DOCK_DRAG_THRESHOLD_PX = 4;

const STATUS_LABEL: Record<DockStatus, string> = {
  waiting: "waiting for the model",
  reading: "the model is reading it",
  ready: "ready",
  failed: "enrichment failed"
};

export function DockStatusGlyph({ status }: { status: DockStatus }): React.ReactElement {
  return (
    <span className="fod-st" data-status={status} aria-hidden="true">
      {status === "ready" ? <FoIcon name="check" size={9} /> : status === "failed" ? "!" : null}
    </span>
  );
}

function DockThumb({ item }: { item: Pick<DockItem, "captureId" | "record"> }): React.ReactElement {
  const record = item.record;
  if (record?.kind === "video") {
    return (
      <span className="fod-thumb fod-thumb--video">
        <FoIcon name="play" size={12} />
      </span>
    );
  }
  const src =
    record === null
      ? captureSrcUrl(item.captureId)
      : cacheUrl(item.captureId, 240, "webp", record.edits_version);
  return (
    <span className="fod-thumb">
      <img src={src} alt="" draggable={false} />
    </span>
  );
}

function itemAriaLabel(item: DockItem): string {
  const status = dockItemStatus(item);
  return status === null ? dockItemTitle(item) : `${dockItemTitle(item)} — ${STATUS_LABEL[status]}`;
}

export type FloatOverDockProps = {
  readonly items: readonly DockItem[];
  /** Snaps past the cap. The ⋮ tab shows only when there are some. */
  readonly overflowCount: number;
  readonly side: FloatOverDockSide;
  readonly onOpen: (captureId: string) => void;
  readonly onMore: () => void;
};

/**
 * The tabs on the screen edge. Rest: an 18px sliver per snap. Hover: the
 * stack slides out, and the tab under the pointer comes all the way. Press and drag: moves the
 * stack along the edge (main follows the cursor and flips sides past the
 * middle of the display).
 *
 * The outer box is what FloatOverHost measures, so its width IS the
 * window's width; the 84px stack inside is pinned to the screen-edge
 * side and the window's own edge clips it.
 */
export function FloatOverDock({
  items,
  overflowCount,
  side,
  onOpen,
  onMore
}: FloatOverDockProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const [wide, setWide] = useState(false);
  const [underId, setUnderId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pressRef = useRef<{ x: number; y: number; target: string; pointerId: number } | null>(
    null
  );
  const draggingRef = useRef(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const out = hovered || dragging;
  useEffect(() => {
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    if (out) {
      setWide(true);
      return undefined;
    }
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null;
      setWide(false);
    }, DOCK_COLLAPSE_MS);
    return () => {
      if (collapseTimerRef.current !== null) clearTimeout(collapseTimerRef.current);
    };
  }, [out]);

  const showMore = overflowCount > 0;
  const count = items.length + (showMore ? 1 : 0);
  const height =
    items.length * DOCK_TAB_HEIGHT +
    (showMore ? DOCK_MORE_HEIGHT : 0) +
    Math.max(0, count - 1) * DOCK_TAB_GAP;
  const width = wide ? DOCK_TAB_WIDTH : DOCK_REST_PEEK;

  const endDrag = (): void => {
    if (draggingRef.current) {
      draggingRef.current = false;
      setDragging(false);
      window.pwrsnapApi?.requestFloatOverDockDrag?.("end");
    }
    pressRef.current = null;
  };

  const pointerHandlers = (target: string) => ({
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      pressRef.current = { x: event.screenX, y: event.screenY, target, pointerId: event.pointerId };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // No capture: the drag still works while the pointer stays over
        // the dock, and a window-level pointerup ends it.
      }
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const press = pressRef.current;
      if (press === null || press.pointerId !== event.pointerId) return;
      if (!draggingRef.current) {
        const moved = Math.hypot(event.screenX - press.x, event.screenY - press.y);
        if (moved < DOCK_DRAG_THRESHOLD_PX) return;
        draggingRef.current = true;
        setDragging(true);
        window.pwrsnapApi?.requestFloatOverDockDrag?.("start");
      }
      window.pwrsnapApi?.requestFloatOverDockDrag?.("move");
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const press = pressRef.current;
      if (press === null || press.pointerId !== event.pointerId) return;
      const wasDrag = draggingRef.current;
      endDrag();
      if (wasDrag) return;
      if (target === "more") onMore();
      else onOpen(target);
    },
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    // Enter / Space on a focused tab arrive as a click with no pointer
    // before it (`detail === 0`). A pointer click was already handled
    // at pointerup, where a drag can still claim it.
    onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (event.detail !== 0) return;
      if (target === "more") onMore();
      else onOpen(target);
    }
  });

  useEffect(() => {
    // Backstop: a pointerup that never reached the tab (capture refused)
    // must still end the drag, or main keeps following the cursor.
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, []);

  return (
    <div
      className={`fod fod--${side}${out ? " is-out" : ""}${dragging ? " is-dragging" : ""}`}
      style={{ width, height }}
      data-testid="float-over-dock"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setUnderId(null);
      }}
    >
      <div className="fod__stack" role="group" aria-label="Recent snaps">
        {items.map((item) => {
          const status = dockItemStatus(item);
          return (
            <button
              key={item.captureId}
              type="button"
              className={`fod-tab${underId === item.captureId ? " is-under" : ""}`}
              data-status={status ?? "none"}
              aria-label={`Open ${itemAriaLabel(item)}`}
              title={dockItemTitle(item)}
              onMouseEnter={() => setUnderId(item.captureId)}
              {...pointerHandlers(item.captureId)}
            >
              <DockThumb item={item} />
              {status !== null ? <DockStatusGlyph status={status} /> : null}
            </button>
          );
        })}
        {showMore ? (
          <button
            type="button"
            className="fod-more"
            aria-label={`${overflowCount} more snaps`}
            onMouseEnter={() => setUnderId(null)}
            {...pointerHandlers("more")}
          >
            <FoIcon name="more" size={12} />
            <span>+{overflowCount}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export type FloatOverRailProps = {
  /** The catalog, newest first (see `catalogRailItems`). */
  readonly items: readonly RailItem[];
  readonly currentId: string | null;
  /** Snaps the model is still on, for the eyebrow. */
  readonly inFlightCount: number;
  /** More pages of the catalog wait behind the last one loaded. */
  readonly hasMore: boolean;
  readonly onOpen: (captureId: string) => void;
  /** The list has scrolled near its end: load the next page. */
  readonly onNearEnd: () => void;
  readonly onHoverChange: (hovering: boolean) => void;
};

/** Load the next page this far before the end of the loaded list. */
const RAIL_PREFETCH_PX = 240;

/**
 * The recent-snaps catalog, beside an open toast. As tall as its
 * thumbnails, capped at the toast's height (the host publishes
 * `--fo-rail-max`); past that it scrolls. Clicking a thumb swaps the
 * toast to that snap, and nothing leaves the list for having been
 * opened. The toast's own snap is ringed.
 */
export function FloatOverRail({
  items,
  currentId,
  inFlightCount,
  hasMore,
  onOpen,
  onNearEnd,
  onHoverChange
}: FloatOverRailProps): React.ReactElement {
  const listRef = useRef<HTMLDivElement | null>(null);
  const newestId = items[0]?.captureId ?? null;
  // One clock for every thumb: seconds while the newest is under an
  // hour old, minutes after that.
  const newestAt = items[0] === undefined ? null : capturedAtMs(items[0].record.captured_at);
  const now = useNow(newestAt === null ? null : ageTickMs(newestAt, Date.now()));

  // A new capture is the newest row and the one on the toast: bring the
  // list back to the top for it. Opening an older snap leaves the list
  // where the user scrolled it.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null && newestId !== null && newestId === currentId) list.scrollTop = 0;
  }, [newestId, currentId]);

  const checkNearEnd = (): void => {
    const list = listRef.current;
    if (list === null || !hasMore) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - RAIL_PREFETCH_PX) onNearEnd();
  };
  // A first page that does not fill the rail never scrolls; ask for the
  // next one straight away.
  useEffect(checkNearEnd, [items.length, hasMore]);

  return (
    <div
      className="fo-rail"
      data-testid="float-over-rail"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div className="fo-rail__eb">
        <span>Recent</span>
        {inFlightCount > 0 ? (
          <b title={`${inFlightCount} still with the model`}>
            <span className="fod-st" data-status="reading" aria-hidden="true" />
            {inFlightCount}
          </b>
        ) : null}
      </div>
      <div
        ref={listRef}
        className="fo-rail__list"
        role="list"
        aria-label="Recent snaps"
        onScroll={checkNearEnd}
      >
        {items.map((item) => {
          const current = item.captureId === currentId;
          const at = capturedAtMs(item.record.captured_at);
          const label = railItemLabel(item);
          return (
            <button
              key={item.captureId}
              type="button"
              role="listitem"
              className={`fo-rail__item${current ? " is-current" : ""}`}
              data-capture-id={item.captureId}
              data-status={item.status ?? "none"}
              aria-current={current ? "true" : undefined}
              aria-label={current ? `Showing ${label}` : `Open ${label}`}
              title={dockItemTitle({ ...item, addedAt: 0 })}
              onClick={() => {
                if (!current) onOpen(item.captureId);
              }}
            >
              <DockThumb item={item} />
              {item.status !== null ? <DockStatusGlyph status={item.status} /> : null}
              {at !== null ? <span className="fo-rail__age">{formatThumbAge(at, now)}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function railItemLabel(item: RailItem): string {
  const title = dockItemTitle({ ...item, addedAt: 0 });
  return item.status === null ? title : `${title} — ${STATUS_LABEL[item.status]}`;
}
