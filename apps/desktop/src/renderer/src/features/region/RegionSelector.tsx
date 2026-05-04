// Region-selector renderer.
//
// State machine (post-feedback redesign):
//
//   snap (default, live):
//     The cursor walks the screen; the rect locks to whichever
//     window the cursor is over (snap target = window). When the
//     cursor is over background, the rect locks to the entire
//     display (snap target = display). The user does nothing — it
//     just tracks. ↵ commits. esc cancels.
//
//   pending:
//     The user pressed mousedown but hasn't moved past the drag
//     threshold yet. The snap rect is held. We're undecided
//     between "click to confirm snap" and "drag to free-draw".
//
//   drawing:
//     The user moved past threshold while pending → free-form
//     region drag. Overrides the snap rect.
//
//   adjusting:
//     A rect has been committed (by click-on-snap, by drag-end, or
//     by ↵ from snap). Handles are live, drag-to-move works, arrow
//     keys nudge, ⇧+arrow nudges by 10px. ↵ submits to main; esc
//     cancels. mousedown outside the rect drops back to snap mode.
//
//   moving / resizing:
//     Sub-states of adjusting; mouse drives translation / edge drag.
//
// All three commit paths (snap-click, drag-end, ↵-from-snap) land in
// adjusting before submission, so the user always gets a chance to
// refine before it goes through.
//
// Coords reported to main are in window-local px (= display-local;
// the selector window covers the whole display). Main converts to
// global virtual coords + display id before screencapture.

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

type SnapTarget =
  | { kind: "window"; entry: WindowSnapEntry }
  | { kind: "display" };

type Interaction =
  | { kind: "snap" } // live-snap; rect tracks cursor
  | {
      kind: "pending";
      startX: number;
      startY: number;
      // Snap target captured at mousedown — preserved if mouseup
      // happens before the drag threshold (so the click commits
      // exactly the snap that was visible when the user clicked).
      snapAtPress: SnapTarget | null;
    }
  | { kind: "drawing"; startX: number; startY: number }
  | { kind: "adjusting" } // rect committed; handles + nudge live
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

function displaySnapRect(): Rect {
  const v = viewport();
  return { x: 0, y: 0, w: v.width, h: v.height };
}

export function RegionSelector() {
  const displayIdParam = parseHashParam(HASH_PARAM_DISPLAY_ID);
  const displayId = displayIdParam !== null ? Number.parseInt(displayIdParam, 10) : 0;

  // Initialize with display-snap so the user sees a frame around the
  // whole display the moment the selector opens, before main has
  // even pushed the window list.
  const [rect, setRect] = useState<Rect>(displaySnapRect);
  const [snapTarget, setSnapTarget] = useState<SnapTarget>({ kind: "display" });
  const [interaction, setInteraction] = useState<Interaction>({ kind: "snap" });
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Refs mirror state so global event handlers (registered once on
  // mount) read the freshest values without closure-capture stale-data.
  const rectRef = useRef<Rect>(rect);
  const interactionRef = useRef<Interaction>(interaction);
  const spaceRef = useRef(false);
  const snapTargetRef = useRef<SnapTarget>(snapTarget);
  const windowsRef = useRef<readonly WindowSnapEntry[]>([]);
  // Coord-space scale: how many CSS pixels equal one display-logical
  // pixel. On macOS "scaled" display modes (fractional
  // devicePixelRatio, e.g. 2.629), `window.innerWidth` is NOT equal
  // to `display.bounds.width` even though both are nominally "DIP".
  // Main ships rects in display logical px; we render in CSS px;
  // this scale bridges them. Default 1 until the first snapshot
  // arrives with displayBounds.
  const cssToLogicalRef = useRef(1);
  // Last-known cursor position. Updated on every mousemove so
  // keyboard handlers (Tab cycle in particular) know where to
  // hit-test from.
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  rectRef.current = rect;
  interactionRef.current = interaction;
  spaceRef.current = spaceHeld;
  snapTargetRef.current = snapTarget;

  // Surface state to CSS for cursor switching + snap visualization.
  useLayoutEffect(() => {
    document.body.dataset.interaction = interaction.kind;
    document.body.dataset.spaceHeld = spaceHeld ? "true" : "false";
    document.body.dataset.snap =
      interaction.kind === "snap" || interaction.kind === "pending"
        ? snapTarget.kind
        : "off";
  }, [interaction.kind, spaceHeld, snapTarget]);

  // Window-list snapshot from main. Empty until the helper resolves;
  // until then, snap defaults to display.
  //
  // useLayoutEffect (not useEffect) so the subscription is attached
  // BEFORE React yields to the browser. Otherwise the renderer can
  // receive the body[data-snap] attribute (set in our other
  // useLayoutEffect) before the IPC subscription is live, which
  // races: tests that observe the attribute and immediately push a
  // snapshot via webContents.send find no listener attached.
  //
  // We also stamp body[data-window-list-count] every time a snapshot
  // arrives — gives tests a deterministic "snapshot has landed in
  // the renderer" signal to wait on, rather than racing the IPC
  // delivery against a synthetic mouse move.
  useLayoutEffect(() => {
    const unsubscribe = window.pwrsnapApi?.onWindowListSnapshot((payload) => {
      // Compute the renderer-vs-main coord-space scale. On scaled-
      // mode Retina displays this is < 1 (e.g. 1460/1920 ≈ 0.76).
      // On standard 2× Retina or non-Retina it's 1.
      const scale =
        payload.displayBounds.width > 0
          ? window.innerWidth / payload.displayBounds.width
          : 1;
      cssToLogicalRef.current = scale;
      // Rescale every rect from display-logical px → CSS px so the
      // renderer can hit-test against event.clientX/Y (CSS px) and
      // render via inline `style.width` (CSS px) directly.
      windowsRef.current = payload.windows.map((w) => ({
        ...w,
        rect: {
          x: w.rect.x * scale,
          y: w.rect.y * scale,
          w: w.rect.w * scale,
          h: w.rect.h * scale
        },
        rawRect: {
          x: w.rawRect.x * scale,
          y: w.rawRect.y * scale,
          w: w.rawRect.w * scale,
          h: w.rawRect.h * scale
        }
      }));
      document.body.dataset.windowListCount = String(payload.windows.length);
    });
    document.body.dataset.windowListReady = "1";
    // Diagnostic — push the renderer's view of the world back to
    // main so the user sees it in the regular terminal log next to
    // the `snap candidates` line, no DevTools console needed.
    // Reports innerWidth/Height (the CSS coord space the rect is
    // rendered in), devicePixelRatio (Retina factor), and screen
    // dims so we can compare against display.bounds + content size
    // on the main side.
    window.pwrsnapApi?.reportSelectorDiagnostics({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  function findWindowAt(clientX: number, clientY: number): WindowSnapEntry | null {
    // Walk the z-order ascending (frontmost first). Hit-test uses
    // the RAW bounds so the result matches what the OS considers
    // topmost-at-point. If the topmost is one of our own windows
    // (the library, float-over, etc.), return null — the cursor is
    // visually on a non-snappable surface; fall back to display
    // snap rather than picking a window underneath that the user
    // can't actually see.
    for (const w of windowsRef.current) {
      if (
        clientX >= w.rawRect.x &&
        clientX <= w.rawRect.x + w.rawRect.w &&
        clientY >= w.rawRect.y &&
        clientY <= w.rawRect.y + w.rawRect.h
      ) {
        return w.ownedByUs ? null : w;
      }
    }
    return null;
  }

  function snapAt(clientX: number, clientY: number): SnapTarget {
    const win = findWindowAt(clientX, clientY);
    return win !== null ? { kind: "window", entry: win } : { kind: "display" };
  }

  function rectForSnap(snap: SnapTarget): Rect {
    if (snap.kind === "window") {
      return { x: snap.entry.rect.x, y: snap.entry.rect.y, w: snap.entry.rect.w, h: snap.entry.rect.h };
    }
    return displaySnapRect();
  }

  function commit(): void {
    const r = rectRef.current;
    if (r.w < MIN_DRAG_PX || r.h < MIN_DRAG_PX) {
      cancel();
      return;
    }
    const snap = snapTargetRef.current;
    // The renderer's rect is in CSS pixels. Main + screencapture
    // expect display-logical pixels. Scale back via the inverse of
    // the snapshot's css-to-logical factor. On standard displays
    // this is 1.0 — no-op. On scaled-mode Retina (e.g. inner=1460
    // logical=1920) it's ~1.315 and corrects the doubling we'd
    // otherwise see in the captured PNG.
    const inv = cssToLogicalRef.current > 0 ? 1 / cssToLogicalRef.current : 1;
    window.pwrsnapApi?.submitRegion({
      ok: true,
      rect: {
        x: Math.round(r.x * inv),
        y: Math.round(r.y * inv),
        w: Math.round(r.w * inv),
        h: Math.round(r.h * inv)
      },
      displayId,
      // Tag the payload with the snapped windowId only when we
      // committed straight from a window snap (no drag, no resize).
      // Once the user adjusts the rect in any way the windowId
      // promise no longer holds — main falls back to rect-center
      // hit-testing for source_app_*.
      ...(interaction.kind === "snap" && snap.kind === "window"
        ? { snappedWindowId: snap.entry.windowId }
        : {})
    });
    setInteraction({ kind: "snap" });
    setSnapTarget({ kind: "display" });
    setRect(displaySnapRect());
  }

  function cancel(): void {
    window.pwrsnapApi?.submitRegion({ ok: false });
    setInteraction({ kind: "snap" });
    setSnapTarget({ kind: "display" });
    setRect(displaySnapRect());
  }

  useEffect(() => {
    function getHandleFromTarget(target: EventTarget | null): HandleId | null {
      if (!(target instanceof HTMLElement)) return null;
      const handle = target.dataset.handle;
      if (handle === undefined) return null;
      return ALL_HANDLES.includes(handle as HandleId) ? (handle as HandleId) : null;
    }

    function isInsideCurrentRect(clientX: number, clientY: number): boolean {
      return isPointInsideRect(rectRef.current, clientX, clientY);
    }

    function lastCursor(): { x: number; y: number } {
      // Approximate cursor — onMouseMove keeps `lastMouseRef.current`
      // current; falls back to viewport center if we have nothing yet.
      const v = viewport();
      return lastMouseRef.current ?? { x: v.width / 2, y: v.height / 2 };
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
      if (event.key === "Tab" && interactionRef.current.kind === "snap") {
        // Tab cycles through windows whose raw bounds also contain
        // the cursor — useful for capturing a window mostly hidden
        // under another. Walks forward in z-order on Tab, backward
        // on Shift+Tab. Skips windows we own (library, float-over,
        // etc.) since they're never snap targets.
        event.preventDefault();
        const cur = lastCursor();
        const all = windowsRef.current;
        const candidates = all.filter(
          (w) =>
            !w.ownedByUs &&
            cur.x >= w.rawRect.x &&
            cur.x <= w.rawRect.x + w.rawRect.w &&
            cur.y >= w.rawRect.y &&
            cur.y <= w.rawRect.y + w.rawRect.h
        );
        if (candidates.length === 0) return;
        const currentTarget = snapTargetRef.current;
        const currentIdx =
          currentTarget.kind === "window"
            ? candidates.findIndex((w) => w.windowId === currentTarget.entry.windowId)
            : -1;
        const dir = event.shiftKey ? -1 : 1;
        // Wrap around with proper modulo for negative direction.
        const nextIdx =
          (currentIdx + dir + candidates.length) % candidates.length;
        const next: SnapTarget = { kind: "window", entry: candidates[nextIdx]! };
        setSnapTarget(next);
        setRect({
          x: next.entry.rect.x,
          y: next.entry.rect.y,
          w: next.entry.rect.w,
          h: next.entry.rect.h
        });
        return;
      }
      if (event.key === " " && !spaceRef.current) {
        // Space-hold: convert any subsequent mousedown into a move
        // anchored on the current rect, even when the cursor is
        // outside. Only useful during adjusting; in snap mode there's
        // nothing to move around.
        if (interactionRef.current.kind === "adjusting") {
          event.preventDefault();
          setSpaceHeld(true);
        }
        return;
      }
      // Arrow-key nudge — only when adjusting (no live drag).
      if (interactionRef.current.kind !== "adjusting") return;
      const r = rectRef.current;
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
    }

    function onMouseDown(event: MouseEvent): void {
      if (event.button !== 0) return;
      event.preventDefault();
      const handle = getHandleFromTarget(event.target);
      const i = interactionRef.current;

      // Adjusting → handle drag = resize.
      if (handle !== null && i.kind === "adjusting") {
        setInteraction({
          kind: "resizing",
          handle,
          startMouse: { x: event.clientX, y: event.clientY },
          startRect: rectRef.current
        });
        return;
      }

      // Adjusting → click inside (or Space held) = move.
      if (
        i.kind === "adjusting" &&
        (spaceRef.current || isInsideCurrentRect(event.clientX, event.clientY))
      ) {
        setInteraction({
          kind: "moving",
          startMouse: { x: event.clientX, y: event.clientY },
          startRect: rectRef.current
        });
        return;
      }

      // Adjusting → click outside the rect: drop back to snap mode.
      // The next mousemove will set up a fresh snap target.
      if (i.kind === "adjusting") {
        const next = snapAt(event.clientX, event.clientY);
        setSnapTarget(next);
        setRect(rectForSnap(next));
        // Fall through into pending so that this same click can
        // either commit the new snap or start a free draw.
      }

      // From snap (or just-dropped-from-adjusting): start pending.
      // We don't transition to drawing yet — we wait to see if the
      // mouseup happens before MIN_DRAG_PX of movement (= click
      // confirms snap) or after (= free-draw).
      setInteraction({
        kind: "pending",
        startX: event.clientX,
        startY: event.clientY,
        snapAtPress: snapTargetRef.current
      });
    }

    function onMouseMove(event: MouseEvent): void {
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
      const i = interactionRef.current;
      switch (i.kind) {
        case "snap": {
          // Live snap: recompute target from cursor, repaint rect.
          const next = snapAt(event.clientX, event.clientY);
          if (
            (next.kind === "window" &&
              snapTargetRef.current.kind === "window" &&
              snapTargetRef.current.entry.windowId === next.entry.windowId) ||
            (next.kind === "display" && snapTargetRef.current.kind === "display")
          ) {
            return; // unchanged — skip re-render
          }
          // Diagnostic — every snap-target change. Pair this with the
          // main-side `snap candidates` log to verify what the helper
          // reported vs what the renderer ended up showing.
          // eslint-disable-next-line no-console
          console.debug("[snap]", {
            cursor: { x: event.clientX, y: event.clientY },
            viewport: viewport(),
            target:
              next.kind === "window"
                ? {
                    kind: "window",
                    windowId: next.entry.windowId,
                    app: next.entry.appName,
                    rect: next.entry.rect
                  }
                : { kind: "display", rect: displaySnapRect() }
          });
          setSnapTarget(next);
          setRect(rectForSnap(next));
          return;
        }
        case "pending": {
          // Watch for the threshold cross. Up until then the snap
          // rect stays visible — once we cross, switch to free-draw.
          const dx = event.clientX - i.startX;
          const dy = event.clientY - i.startY;
          if (Math.hypot(dx, dy) < MIN_DRAG_PX) return;
          // Cross — start drawing. Override the snap rect with a
          // free-draw rect anchored at the original mousedown.
          setRect(
            rectFromTwoPoints(
              { x: i.startX, y: i.startY },
              { x: event.clientX, y: event.clientY }
            )
          );
          setInteraction({
            kind: "drawing",
            startX: i.startX,
            startY: i.startY
          });
          return;
        }
        case "drawing": {
          setRect(
            rectFromTwoPoints(
              { x: i.startX, y: i.startY },
              { x: event.clientX, y: event.clientY }
            )
          );
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
        case "adjusting":
          return;
      }
    }

    function onMouseUp(event: MouseEvent): void {
      const i = interactionRef.current;
      if (i.kind === "snap" || i.kind === "adjusting") return;
      event.preventDefault();
      switch (i.kind) {
        case "pending": {
          // Click without drag → commit the snap target into
          // adjusting. The user can refine with handles + arrow
          // keys + ↵, or hit ↵ immediately to send.
          const snap = i.snapAtPress;
          if (snap !== null) {
            setSnapTarget(snap);
            setRect(rectForSnap(snap));
          }
          setInteraction({ kind: "adjusting" });
          return;
        }
        case "drawing": {
          const r = rectRef.current;
          if (r.w < MIN_DRAG_PX || r.h < MIN_DRAG_PX) {
            // Tiny drag — treat as a click. Snap commit.
            setInteraction({ kind: "snap" });
            const next = snapAt(event.clientX, event.clientY);
            setSnapTarget(next);
            setRect(rectForSnap(next));
            return;
          }
          // Real free-draw rect — no longer a snap selection.
          setSnapTarget({ kind: "display" }); // semantically "no window"
          setInteraction({ kind: "adjusting" });
          return;
        }
        case "moving":
        case "resizing":
          setInteraction({ kind: "adjusting" });
          return;
      }
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

  const isAdjustable = interaction.kind === "adjusting";
  const isSnap = interaction.kind === "snap" || interaction.kind === "pending";
  const dimsChipPosition: { left: number; top: number } | null = {
    left: rect.x,
    top: rect.y > 30 ? rect.y - 30 : rect.y + rect.h + 6
  };

  // Hint copy varies by mode + snap target so the user always knows
  // what action is bound to click / drag / arrows.
  const hint = (() => {
    if (interaction.kind === "snap" || interaction.kind === "pending") {
      const what =
        snapTarget.kind === "window"
          ? snapTarget.entry.appName ?? "window"
          : "display";
      return (
        <>
          <span>
            <kbd>click</kbd>capture {what}
          </span>
          <span className="region-hint-sep">·</span>
          <span>
            <kbd>drag</kbd>region
          </span>
          <span className="region-hint-sep">·</span>
          <span>
            <kbd>tab</kbd>next window
          </span>
          <span className="region-hint-sep">·</span>
          <span>
            <kbd>↵</kbd>commit
          </span>
        </>
      );
    }
    if (isAdjustable) {
      return (
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
      );
    }
    return (
      <span>
        <kbd>release</kbd>to adjust
      </span>
    );
  })();

  return (
    <div className="region-root">
      {/* Four-quadrant dim mask. Always rendered — the rect is always
          present (snap rect at boot, drawn / committed rect later). */}
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
        className={
          "region-rect" +
          (isAdjustable ? " region-rect--adjustable" : "") +
          (isSnap ? ` region-rect--snap-${snapTarget.kind}` : "")
        }
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
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
          {isSnap && snapTarget.kind === "window" ? (
            <>
              {snapTarget.entry.appName ?? "Window"} · {Math.round(rect.w)} × {Math.round(rect.h)}
            </>
          ) : isSnap && snapTarget.kind === "display" ? (
            <>
              Display · {Math.round(rect.w)} × {Math.round(rect.h)}
            </>
          ) : (
            <>
              {Math.round(rect.w)} × {Math.round(rect.h)}
            </>
          )}
        </div>
      )}

      <div className="region-hint">
        {hint}
        <span className="region-hint-sep">·</span>
        <span>
          <kbd>esc</kbd>cancel
        </span>
      </div>
    </div>
  );
}
