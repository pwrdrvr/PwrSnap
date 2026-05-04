// Region-selector renderer — Phase 1.10.
//
// State machine:
//   idle     — no rect; mousedown anywhere starts drawing.
//   drawing  — first drag from initial mousedown; mouseup → adjusting
//              (or back to idle if the rect is degenerate < 4×4 px).
//   adjusting — rect is frozen and editable. Mouseup transitioned us
//              here. Sub-states:
//                resizing — mousedown on a handle, drag updates that edge.
//                moving   — mousedown on the rect interior, or with
//                           Space held anywhere; drag translates rect.
//   ESC      — cancel from any state.
//   ↵        — commit current rect (must have non-zero size).
//   Arrow    — nudge top-left; Shift = ×10. Only in adjusting.
//
// Coords reported to main are in *display-local* (= window-local;
// the selector window covers the entire display). Main converts to
// the global virtual coord space + display id before shelling out
// to screencapture.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WindowSnapEntry } from "../../preload-types";
import {
  ALL_HANDLES,
  applyResize,
  clampRectToViewport,
  isPointInsideRect,
  rectFromTwoPoints,
  type HandleId,
  type Point,
  type Rect
} from "./region-math";

const HASH_PARAM_DISPLAY_ID = "displayId";
const MIN_DRAG_PX = 4;
const NUDGE_PX = 1;
const NUDGE_PX_SHIFT = 10;

type Interaction =
  | { kind: "idle" }
  | { kind: "drawing"; startX: number; startY: number; currentX: number; currentY: number }
  | { kind: "moving"; startMouse: Point; startRect: Rect }
  | { kind: "resizing"; handle: HandleId; startMouse: Point; startRect: Rect };

function parseHashParam(name: string): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return params.get(name);
}

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function RegionSelector() {
  const displayIdParam = parseHashParam(HASH_PARAM_DISPLAY_ID);
  const displayId = displayIdParam !== null ? Number.parseInt(displayIdParam, 10) : 0;

  const [rect, setRect] = useState<Rect | null>(null);
  const [interaction, setInteraction] = useState<Interaction>({ kind: "idle" });
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Snap-to-window state. When ⇧ is held with no active drag, the
  // selector locks to whichever window's bounds the cursor is over.
  // Releasing ⇧ goes back to free-draw mode. Committing while snapped
  // ships the snapped windowId back to main so source_app_* tagging
  // can use the exact window the user picked rather than guessing
  // by rect-center hit-test.
  const [shiftHeld, setShiftHeld] = useState(false);
  const [snapTarget, setSnapTarget] = useState<WindowSnapEntry | null>(null);

  // Refs mirror state so global event handlers (registered once on
  // mount) read the freshest values without closure-capture stale-data.
  const rectRef = useRef<Rect | null>(null);
  const interactionRef = useRef<Interaction>({ kind: "idle" });
  const spaceRef = useRef(false);
  const shiftRef = useRef(false);
  const snapTargetRef = useRef<WindowSnapEntry | null>(null);
  const windowsRef = useRef<readonly WindowSnapEntry[]>([]);
  rectRef.current = rect;
  interactionRef.current = interaction;
  spaceRef.current = spaceHeld;
  shiftRef.current = shiftHeld;
  snapTargetRef.current = snapTarget;

  // Surface state to CSS for cursor switching.
  useLayoutEffect(() => {
    document.body.dataset.interaction = interaction.kind;
    document.body.dataset.spaceHeld = spaceHeld ? "true" : "false";
    document.body.dataset.snap = snapTarget !== null ? "true" : "false";
  }, [interaction.kind, spaceHeld, snapTarget]);

  // Subscribe to the window list main pushes after the selector
  // shows. Empty initial list — if the helper is unavailable, snap
  // simply does nothing and the selector falls back to free-draw.
  useEffect(() => {
    const unsubscribe = window.pwrsnapApi?.onWindowListSnapshot((payload) => {
      windowsRef.current = payload.windows;
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  function findWindowAt(clientX: number, clientY: number): WindowSnapEntry | null {
    // Window list is in window-local coords (main translated from
    // global before shipping). Front-most first — the helper returns
    // them in z-order so a linear scan finds the topmost owner.
    for (const w of windowsRef.current) {
      if (
        clientX >= w.rect.x &&
        clientX <= w.rect.x + w.rect.w &&
        clientY >= w.rect.y &&
        clientY <= w.rect.y + w.rect.h
      ) {
        return w;
      }
    }
    return null;
  }

  function commit(): void {
    // Snap commit: ⇧ snap target locked in. The rect was already set
    // to the target window's bounds when the cursor entered it, so
    // we use the snap target's bounds (authoritative) and tag the
    // payload with windowId so main can verify and backfill
    // `source_app_*` deterministically.
    const snap = snapTargetRef.current;
    if (snap !== null) {
      window.pwrsnapApi?.submitRegion({
        ok: true,
        rect: {
          x: Math.round(snap.rect.x),
          y: Math.round(snap.rect.y),
          w: Math.round(snap.rect.w),
          h: Math.round(snap.rect.h)
        },
        displayId,
        snappedWindowId: snap.windowId
      });
      setRect(null);
      setSnapTarget(null);
      setInteraction({ kind: "idle" });
      return;
    }

    const r = rectRef.current;
    if (r === null || r.w < MIN_DRAG_PX || r.h < MIN_DRAG_PX) {
      cancel();
      return;
    }
    window.pwrsnapApi?.submitRegion({
      ok: true,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.w),
        h: Math.round(r.h)
      },
      displayId
    });
    setRect(null);
    setInteraction({ kind: "idle" });
  }

  function cancel(): void {
    window.pwrsnapApi?.submitRegion({ ok: false });
    setRect(null);
    setInteraction({ kind: "idle" });
  }

  useEffect(() => {
    function getHandleFromTarget(target: EventTarget | null): HandleId | null {
      if (!(target instanceof HTMLElement)) return null;
      const handle = target.dataset.handle;
      if (handle === undefined) return null;
      return ALL_HANDLES.includes(handle as HandleId) ? (handle as HandleId) : null;
    }

    function isInsideCurrentRect(clientX: number, clientY: number): boolean {
      const r = rectRef.current;
      if (r === null) return false;
      return isPointInsideRect(r, clientX, clientY);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        return;
      }
      if (event.key === " " && !spaceRef.current) {
        // Space-hold: convert any subsequent mousedown into a move
        // anchored on the current rect, even when the cursor is outside.
        event.preventDefault();
        setSpaceHeld(true);
        return;
      }
      // ⇧ enters snap-to-window mode while held — but only when no
      // user drag is in flight (Shift+drag is reserved for arrow-
      // key nudge × 10 + future "constrain proportions" gesture).
      if (event.key === "Shift" && !shiftRef.current) {
        if (interactionRef.current.kind === "idle" || interactionRef.current.kind === "drawing") {
          setShiftHeld(true);
        }
        return;
      }
      // Arrow-key nudge — only when adjusting (rect persisted, no
      // active drag).
      const r = rectRef.current;
      if (r === null) return;
      if (interactionRef.current.kind !== "idle") return;
      const step = event.shiftKey ? NUDGE_PX_SHIFT : NUDGE_PX;
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = -step;
      else if (event.key === "ArrowDown") dy = step;
      else return;
      event.preventDefault();
      setRect(clampRectToViewport({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, viewport()));
    }

    function onKeyUp(event: KeyboardEvent): void {
      if (event.key === " ") {
        setSpaceHeld(false);
      }
      if (event.key === "Shift") {
        setShiftHeld(false);
        setSnapTarget(null);
      }
    }

    function onMouseDown(event: MouseEvent): void {
      if (event.button !== 0) return;
      event.preventDefault();
      // Snap-click — ⇧ held with a snap target locked in. Click
      // commits the snapped window's bounds immediately (no drag).
      if (shiftRef.current && snapTargetRef.current !== null) {
        commit();
        return;
      }
      const handle = getHandleFromTarget(event.target);
      const r = rectRef.current;

      if (handle !== null && r !== null) {
        // Resize from this edge / corner.
        setInteraction({
          kind: "resizing",
          handle,
          startMouse: { x: event.clientX, y: event.clientY },
          startRect: r
        });
        return;
      }

      // Move-mode: cursor inside rect, or Space held.
      if (r !== null && (spaceRef.current || isInsideCurrentRect(event.clientX, event.clientY))) {
        setInteraction({
          kind: "moving",
          startMouse: { x: event.clientX, y: event.clientY },
          startRect: r
        });
        return;
      }

      // Otherwise: start drawing a fresh rect from this point. This
      // discards any prior rect — clicking outside an adjustable rect
      // is interpreted as "I want a different region."
      setRect({ x: event.clientX, y: event.clientY, w: 0, h: 0 });
      setInteraction({
        kind: "drawing",
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY
      });
    }

    function onMouseMove(event: MouseEvent): void {
      const i = interactionRef.current;
      // Snap-to-window: when ⇧ is held with no active drag, the
      // cursor's window owner is the snap target. The visualization
      // rect == the window's bounds.
      if (shiftRef.current && (i.kind === "idle" || i.kind === "drawing")) {
        const w = findWindowAt(event.clientX, event.clientY);
        if (w !== null) {
          if (snapTargetRef.current?.windowId !== w.windowId) {
            setSnapTarget(w);
            setRect({ x: w.rect.x, y: w.rect.y, w: w.rect.w, h: w.rect.h });
          }
        } else if (snapTargetRef.current !== null) {
          setSnapTarget(null);
          // Don't clear the user's in-progress rect if they were
          // mid-draw before tapping ⇧; only clear if the rect IS the
          // snap rect.
          if (i.kind !== "drawing") setRect(null);
        }
        if (i.kind !== "drawing") return; // snap mode swallows the move
      }
      switch (i.kind) {
        case "drawing": {
          const next = rectFromTwoPoints(
            { x: i.startX, y: i.startY },
            { x: event.clientX, y: event.clientY }
          );
          setRect(next);
          setInteraction({
            kind: "drawing",
            startX: i.startX,
            startY: i.startY,
            currentX: event.clientX,
            currentY: event.clientY
          });
          return;
        }
        case "moving": {
          const dx = event.clientX - i.startMouse.x;
          const dy = event.clientY - i.startMouse.y;
          setRect(
            clampRectToViewport(
              {
                x: i.startRect.x + dx,
                y: i.startRect.y + dy,
                w: i.startRect.w,
                h: i.startRect.h
              },
              viewport()
            )
          );
          return;
        }
        case "resizing": {
          const dx = event.clientX - i.startMouse.x;
          const dy = event.clientY - i.startMouse.y;
          setRect(applyResize(i.startRect, i.handle, dx, dy));
          return;
        }
        case "idle":
          return;
      }
    }

    function onMouseUp(event: MouseEvent): void {
      const i = interactionRef.current;
      if (i.kind === "idle") return;
      event.preventDefault();
      if (i.kind === "drawing") {
        const r = rectRef.current;
        if (r === null || r.w < MIN_DRAG_PX || r.h < MIN_DRAG_PX) {
          // Click without drag (or accidental tap) — back to idle.
          setRect(null);
          setInteraction({ kind: "idle" });
          return;
        }
      }
      // Settle into adjusting (rect persists, await ↵ commit / ESC
      // cancel / further edits).
      setInteraction({ kind: "idle" });
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    // commit/cancel close over refs only; safe to leave deps empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAdjustable = rect !== null && interaction.kind === "idle";
  const dimsChipPosition: { left: number; top: number } | null = rect
    ? {
        left: rect.x,
        top: rect.y > 30 ? rect.y - 30 : rect.y + rect.h + 6
      }
    : null;

  return (
    <div className="region-root">
      {rect === null ? (
        <div className="region-dim region-dim--full" />
      ) : (
        <>
          {/* Four-quadrant dim mask around the rect. */}
          <div
            className="region-dim"
            style={{ left: 0, top: 0, right: 0, height: Math.max(0, rect.y) }}
          />
          <div
            className="region-dim"
            style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h }}
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
            className={"region-rect" + (isAdjustable ? " region-rect--adjustable" : "")}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          >
            {/* Pointer-events-auto interior captures the move cursor
                only in the adjustable phase; during initial drawing
                the rect is non-interactive so mousemove keeps tracking
                the global handler. */}
            {isAdjustable && (
              <>
                <div className="region-rect-interior" data-interior="true" />
                {ALL_HANDLES.map((h) => (
                  <span key={h} className={`region-handle ${h}`} data-handle={h} />
                ))}
              </>
            )}
          </div>

          {dimsChipPosition !== null && (
            <div
              className="region-dims-chip"
              style={{ left: dimsChipPosition.left, top: dimsChipPosition.top }}
            >
              {snapTarget !== null ? (
                <>
                  {snapTarget.appName ?? "Window"} · {Math.round(rect.w)} × {Math.round(rect.h)}
                </>
              ) : (
                <>
                  {Math.round(rect.w)} × {Math.round(rect.h)}
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="region-hint">
        {snapTarget !== null ? (
          <>
            <span>
              <kbd>click</kbd>capture {snapTarget.appName ?? "window"}
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>release ⇧</kbd>free draw
            </span>
          </>
        ) : rect === null ? (
          <>
            <span>
              <kbd>drag</kbd>to select
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>⇧</kbd>snap to window
            </span>
          </>
        ) : isAdjustable ? (
          <>
            <span>
              <kbd>↵</kbd>commit
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>arrows</kbd>nudge (<kbd>⇧</kbd>×10)
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>space</kbd>+drag move
            </span>
          </>
        ) : (
          <span>
            <kbd>release</kbd>to adjust
          </span>
        )}
        <span className="region-hint-sep">·</span>
        <span>
          <kbd>esc</kbd>cancel
        </span>
      </div>
    </div>
  );
}
