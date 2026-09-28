// The float-over's screen-edge dock (tabs) and the rail that stands in
// for it beside an open toast. Both render the same list, the same
// thumbnails and the same status glyphs; see float-over-dock-model.ts
// for who is in the list and why.

import { useEffect, useRef, useState } from "react";
import type { FloatOverDockSide } from "@pwrsnap/shared";
import { cacheUrl, captureSrcUrl } from "../../lib/pwrsnap";
import { FoIcon } from "./FoIcons";
import {
  dockItemTitle,
  dockStatus,
  formatDockAge,
  type DockItem,
  type DockStatus
} from "./float-over-dock-model";

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

function DockThumb({ item }: { item: DockItem }): React.ReactElement {
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

function itemAriaLabel(item: DockItem, now: number): string {
  return `${dockItemTitle(item)} — ${STATUS_LABEL[dockStatus(item.enrichment)]}, ${formatDockAge(now - item.addedAt)}`;
}

/** Re-render once a second while ages are on screen. */
export function useDockClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export type FloatOverDockProps = {
  readonly items: readonly DockItem[];
  readonly overflowCount: number;
  /** Show the ⋮ tab even with nothing folded: it is also where
   *  "Clear finished" lives. */
  readonly showMore: boolean;
  readonly side: FloatOverDockSide;
  readonly onOpen: (captureId: string) => void;
  readonly onMore: () => void;
};

/**
 * The tabs on the screen edge. Rest: an 18px sliver per snap. Hover: the
 * stack slides out and shows each snap's age. Press and drag: moves the
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
  showMore,
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
  const now = useDockClock(hovered || dragging);

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
      <div className="fod__stack" role="group" aria-label="Snaps waiting for enrichment">
        {items.map((item) => {
          const status = dockStatus(item.enrichment);
          return (
            <button
              key={item.captureId}
              type="button"
              className={`fod-tab${underId === item.captureId ? " is-under" : ""}`}
              data-status={status}
              aria-label={`Open ${itemAriaLabel(item, now)}`}
              title={dockItemTitle(item)}
              onMouseEnter={() => setUnderId(item.captureId)}
              {...pointerHandlers(item.captureId)}
            >
              <DockThumb item={item} />
              <DockStatusGlyph status={status} />
              <span className="fod-tab__age">{formatDockAge(now - item.addedAt)}</span>
            </button>
          );
        })}
        {showMore ? (
          <button
            type="button"
            className={`fod-more${underId === "more" ? " is-under" : ""}`}
            aria-label={
              overflowCount > 0 ? `${overflowCount} more snaps` : "More: clear finished snaps"
            }
            onMouseEnter={() => setUnderId("more")}
            {...pointerHandlers("more")}
          >
            <FoIcon name="more" size={12} />
            {overflowCount > 0 ? <span>+{overflowCount}</span> : null}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export type FloatOverRailProps = {
  readonly items: readonly DockItem[];
  readonly currentId: string | null;
  readonly overflowCount: number;
  readonly showMore: boolean;
  readonly total: number;
  readonly onOpen: (captureId: string) => void;
  readonly onMore: () => void;
  readonly onHoverChange: (hovering: boolean) => void;
};

/**
 * The dock, pulled out beside an open toast. Same list, same glyphs;
 * the toast's own snap is ringed and points at the toast.
 */
export function FloatOverRail({
  items,
  currentId,
  overflowCount,
  showMore,
  total,
  onOpen,
  onMore,
  onHoverChange
}: FloatOverRailProps): React.ReactElement {
  const now = useDockClock(true);
  return (
    <div
      className="fo-rail"
      data-testid="float-over-rail"
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <div className="fo-rail__eb">
        <span>Snaps</span>
        <b>{total}</b>
      </div>
      {items.map((item) => {
        const status = dockStatus(item.enrichment);
        const current = item.captureId === currentId;
        return (
          <button
            key={item.captureId}
            type="button"
            className={`fo-rail__item${current ? " is-current" : ""}`}
            data-status={status}
            aria-current={current ? "true" : undefined}
            aria-label={current ? `Showing ${itemAriaLabel(item, now)}` : `Open ${itemAriaLabel(item, now)}`}
            title={dockItemTitle(item)}
            onClick={() => {
              if (!current) onOpen(item.captureId);
            }}
          >
            <DockThumb item={item} />
            <DockStatusGlyph status={status} />
            <span className="fo-rail__age">{formatDockAge(now - item.addedAt)}</span>
          </button>
        );
      })}
      {showMore ? (
        <button
          type="button"
          className="fo-rail__more"
          aria-label={overflowCount > 0 ? `${overflowCount} more snaps` : "More: clear finished snaps"}
          onClick={onMore}
        >
          <FoIcon name="more" size={12} />
          {overflowCount > 0 ? <span>+{overflowCount}</span> : null}
        </button>
      ) : null}
    </div>
  );
}
