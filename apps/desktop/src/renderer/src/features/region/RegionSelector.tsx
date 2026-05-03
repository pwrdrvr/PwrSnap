// Region-selector renderer. Pure CSS — four `position: fixed` quadrants
// of warm-tinted rgba dim, plus a 1.5px accent border on the live
// rect, plus a dimensions chip. NO `backdrop-filter` (single biggest
// cause of jank over Splashtop).
//
// Coords reported to main are in *display-local* coords (the selector
// window covers the entire display, so client coords map 1:1 to
// display-local). Main bridges to display-bounds + virtual coord
// space when shelling out to screencapture -R.
//
// Behaviors:
//   • Mouse down anywhere → start drag.
//   • Mouse up → commit if rect is at least 4×4; otherwise treat as
//     a click-without-drag (cancel).
//   • Esc → cancel.
//   • Enter → commit current rect (if non-degenerate).

import { useEffect, useRef, useState } from "react";

const HASH_PARAM_DISPLAY_ID = "displayId";

type DragState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
} | null;

function parseHashParam(name: string): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return params.get(name);
}

export function RegionSelector() {
  const displayIdParam = parseHashParam(HASH_PARAM_DISPLAY_ID);
  const displayId = displayIdParam !== null ? Number.parseInt(displayIdParam, 10) : 0;
  const [drag, setDrag] = useState<DragState>(null);
  const draggingRef = useRef(false);
  const dragRef = useRef<DragState>(null);
  dragRef.current = drag;

  // Compute the live rect from drag state.
  const rect = drag
    ? {
        x: Math.min(drag.startX, drag.currentX),
        y: Math.min(drag.startY, drag.currentY),
        w: Math.abs(drag.currentX - drag.startX),
        h: Math.abs(drag.currentY - drag.startY)
      }
    : null;

  function commit(): void {
    const r = dragRef.current;
    if (r === null) {
      cancel();
      return;
    }
    const w = Math.abs(r.currentX - r.startX);
    const h = Math.abs(r.currentY - r.startY);
    if (w < 4 || h < 4) {
      cancel();
      return;
    }
    window.pwrsnapApi?.submitRegion({
      ok: true,
      rect: {
        x: Math.min(r.startX, r.currentX),
        y: Math.min(r.startY, r.currentY),
        w,
        h
      },
      displayId
    });
    setDrag(null);
    draggingRef.current = false;
  }

  function cancel(): void {
    window.pwrsnapApi?.submitRegion({ ok: false });
    setDrag(null);
    draggingRef.current = false;
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    }
    function onMouseDown(event: MouseEvent): void {
      // Left button only.
      if (event.button !== 0) return;
      event.preventDefault();
      draggingRef.current = true;
      setDrag({
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY
      });
    }
    function onMouseMove(event: MouseEvent): void {
      if (!draggingRef.current) return;
      setDrag((prev) =>
        prev === null
          ? null
          : { ...prev, currentX: event.clientX, currentY: event.clientY }
      );
    }
    function onMouseUp(event: MouseEvent): void {
      if (!draggingRef.current) return;
      event.preventDefault();
      commit();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    // commit + cancel are stable closures over refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="region-root">
      {/* Four-quadrant dim mask around the rect. When no drag yet, the
          whole viewport is dimmed. */}
      {rect === null ? (
        <div className="region-dim region-dim--full" />
      ) : (
        <>
          <div
            className="region-dim"
            style={{ left: 0, top: 0, right: 0, height: rect.y }}
          />
          <div
            className="region-dim"
            style={{ left: 0, top: rect.y, width: rect.x, height: rect.h }}
          />
          <div
            className="region-dim"
            style={{
              left: rect.x + rect.w,
              top: rect.y,
              right: 0,
              height: rect.h
            }}
          />
          <div
            className="region-dim"
            style={{ left: 0, top: rect.y + rect.h, right: 0, bottom: 0 }}
          />
          <div
            className="region-rect"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          />
          <div
            className="region-dims-chip"
            style={{
              left: rect.x,
              top: rect.y > 30 ? rect.y - 30 : rect.y + rect.h + 6
            }}
          >
            {rect.w} × {rect.h}
          </div>
        </>
      )}
      <div className="region-hint">
        <span>Drag to select</span>
        <span className="region-hint-sep">·</span>
        <span>↵ commit</span>
        <span className="region-hint-sep">·</span>
        <span>Esc cancel</span>
      </div>
    </div>
  );
}
