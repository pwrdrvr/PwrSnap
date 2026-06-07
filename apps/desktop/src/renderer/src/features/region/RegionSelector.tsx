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
  exceedsDragThreshold,
  isPointInsideRect,
  rectFromTwoPoints,
  rectIsMeaningful,
  type HandleId,
  type Point,
  type Rect
} from "./region-math";

const HASH_PARAM_DISPLAY_ID = "displayId";
const NUDGE_PX = 1;
const NUDGE_PX_SHIFT = 10;
// Escape de-dupe window. A single physical Esc can be delivered twice
// near-simultaneously — once via the focused renderer keydown and once
// via the forwarded globalShortcut IPC. handleEscape() ignores a second
// Escape within this window so one press can't both step back AND
// cancel. Comfortably longer than the IPC hop, far shorter than a
// deliberate second press; also re-armed on the next mousemove.
const ESCAPE_DEDUPE_MS = 50;

type SnapTarget =
  | { kind: "window"; entry: WindowSnapEntry }
  | { kind: "display" };

type SelectorMode = "auto" | "region" | "window";

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
  // Selector mode. Set by main via `region-selector:mode` IPC right
  // before show(). Defaults to 'auto' for backwards-compat with any
  // call site that hasn't migrated yet (e.g. ⌘⇧P pre-mode-aware).
  //   - 'auto'   — current behavior (snap + drag, ⇧ → full-window)
  //   - 'region' — pure rect drag; snap candidates are suppressed; ⇧
  //                does nothing
  //   - 'window' — pure window picker; click commits the snapped
  //                window with fullWindow=true; drag-to-region is
  //                suppressed
  const [mode, setMode] = useState<SelectorMode>("auto");
  // SnagIt-style frozen-screen background. Main captures the screen
  // before show() and ships a `pwrsnap-screen://r/<id>` URL via the
  // mode signal. We render it as a full-window <img> behind the dim
  // mask + rect overlay; the user is interacting with the snapshot,
  // not the live screen. Apps starting / stopping during selection
  // can no longer change what's under the cursor.
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  // Visual intent: 'video' swaps the rect badge + hint copy so the
  // user knows commit starts a recording, not a snap. Defaults to
  // 'snap' for backwards-compat with every call site that doesn't
  // set the flag (Quick Capture, Region, Window, Timed).
  const [intent, setIntent] = useState<"snap" | "video">("snap");
  // ⇧ in snap mode opts into full-window capture: the rect expands
  // from the visible-region bounding box (`entry.rect`) to the
  // window's full bounds (`entry.rawRect`), and the commit payload
  // carries fullWindow:true so main routes to `screencapture -l`.
  // Default (no ⇧) is rect capture — what's literally on screen
  // including any overlapping content.
  const [shiftHeld, setShiftHeld] = useState(false);

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
  const shiftRef = useRef(false);
  const modeRef = useRef<SelectorMode>("auto");
  // Cursor-tracking crosshair guide-lines (auto/region modes). Rendered
  // once and repositioned by direct DOM writes from `onMouseMove` /
  // the window-list cursor — never via React state, so they impose no
  // re-render cost in `adjusting` (where onMouseMove early-returns).
  // Visibility is gated entirely in CSS off body[data-interaction] +
  // body[data-mode]; see region.css.
  const hLineRef = useRef<HTMLDivElement | null>(null);
  const vLineRef = useRef<HTMLDivElement | null>(null);
  // Guards handleEscape against a double-delivered single Esc press.
  const escapeGuardRef = useRef(false);
  // True while an interior mousedown is staging a discard of the
  // committed pick. The branch leaves rect + snapTarget untouched, so a
  // click-without-drag "keep" just stays put (no re-derivation); a drag
  // past threshold redraws. The flag only tells the mouseup which case
  // it is — there is nothing to restore.
  const discardingRef = useRef(false);

  // Write the guide-line positions directly. `x` drives the vertical
  // line's left; `y` drives the horizontal line's top. Reads only the
  // (stable) ref objects, so it's safe to call from the once-registered
  // global handlers without stale-closure risk.
  function positionCrosshair(x: number, y: number): void {
    const hl = hLineRef.current;
    const vl = vLineRef.current;
    if (hl !== null) hl.style.top = `${y}px`;
    if (vl !== null) vl.style.left = `${x}px`;
  }

  useLayoutEffect(() => {
    document.title = "PwrSnap Region Selector";
    // Seed the crosshair at viewport center until the first cursor
    // signal (mousemove or window-list snapshot) arrives, so it never
    // paints at a stray 0,0 corner.
    positionCrosshair(window.innerWidth / 2, window.innerHeight / 2);
    // positionCrosshair only reads stable refs; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  shiftRef.current = shiftHeld;
  rectRef.current = rect;
  interactionRef.current = interaction;
  spaceRef.current = spaceHeld;
  snapTargetRef.current = snapTarget;
  modeRef.current = mode;

  // Surface state to CSS for cursor switching + snap visualization.
  useLayoutEffect(() => {
    document.body.dataset.interaction = interaction.kind;
    document.body.dataset.spaceHeld = spaceHeld ? "true" : "false";
    document.body.dataset.snap =
      interaction.kind === "snap" || interaction.kind === "pending"
        ? snapTarget.kind
        : "off";
    document.body.dataset.fullWindow =
      (shiftHeld || mode === "window") && snapTarget.kind === "window"
        ? "true"
        : "false";
    document.body.dataset.mode = mode;
  }, [interaction.kind, spaceHeld, snapTarget, shiftHeld, mode]);

  // Subscribe to per-show mode signal from main. The selector windows
  // are pre-warmed once at boot so we can't pass mode in the URL hash;
  // main sends it via IPC right before show(), and we apply
  // synchronously so the first paint already reflects the right mode.
  // useLayoutEffect (not useEffect) so the listener attaches before
  // React yields to the browser — same reason as the window-list
  // snapshot subscription above.
  useLayoutEffect(() => {
    const unsub = window.pwrsnapApi?.onSelectorMode((payload) => {
      setMode(payload.mode);
      setScreenUrl(payload.screenUrl ?? null);
      setIntent(payload.intent ?? "snap");
      // When switching INTO 'region' mode, drop any existing window
      // snap target back to display — otherwise the user sees a stale
      // window-snap rect from the previous session before they move
      // the cursor.
      if (payload.mode === "region") {
        setSnapTarget({ kind: "display" });
        setRect(displaySnapRect());
      }
    });
    return () => {
      unsub?.();
    };
  }, []);

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
      const scaledWindows = payload.windows.map((w) => ({
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
      windowsRef.current = scaledWindows;
      if (payload.cursor !== undefined && interactionRef.current.kind === "snap") {
        const cursor = {
          x: payload.cursor.x * scale,
          y: payload.cursor.y * scale
        };
        lastMouseRef.current = cursor;
        positionCrosshair(cursor.x, cursor.y);
        const next = snapAt(cursor.x, cursor.y);
        setSnapTarget(next);
        setRect(rectForSnap(next));
      }
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
    // topmost-at-point. PwrSnap's normal user windows are valid
    // targets; main hides capture chrome before it takes this
    // snapshot so we don't need a same-process exclusion here.
    for (const w of windowsRef.current) {
      if (
        clientX >= w.rawRect.x &&
        clientX <= w.rawRect.x + w.rawRect.w &&
        clientY >= w.rawRect.y &&
        clientY <= w.rawRect.y + w.rawRect.h
      ) {
        return w;
      }
    }
    return null;
  }

  function snapAt(clientX: number, clientY: number): SnapTarget {
    // Region mode = pure rect drag. We never snap to a window —
    // hovering does nothing. The user picks a rect by dragging.
    if (modeRef.current === "region") {
      return { kind: "display" };
    }
    const win = findWindowAt(clientX, clientY);
    return win !== null ? { kind: "window", entry: win } : { kind: "display" };
  }

  function rectForSnap(snap: SnapTarget): Rect {
    if (snap.kind === "window") {
      // window mode = always full-window (occlusion-free backing
      // buffer); auto mode = ⇧-opt-in. Default → use the
      // visible-region bbox (rect). The visual rect always matches
      // what would actually be captured at commit time, so the user
      // has no surprises.
      const wantFull = shiftRef.current || modeRef.current === "window";
      const src = wantFull ? snap.entry.rawRect : snap.entry.rect;
      return { x: src.x, y: src.y, w: src.w, h: src.h };
    }
    return displaySnapRect();
  }

  function commit(): void {
    const r = rectRef.current;
    // Refuse to submit only when the rect has truly zero usable area
    // (no real drag happened). A long thin strip — e.g. 200×1 to grab
    // a status bar — is a legitimate user intent and should commit.
    if (!rectIsMeaningful(r)) {
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
    // A "window snap commit" can happen from any interaction state
    // when we have a window snap target — not just live `snap`. In
    // window-mode the user clicks once, the pending → adjusting flow
    // commits with snap=window even after the brief mouseup.
    const fromWindowSnap = snap.kind === "window";
    const wantFull =
      fromWindowSnap && (shiftRef.current || modeRef.current === "window");
    window.pwrsnapApi?.submitRegion({
      ok: true,
      rect: {
        x: Math.round(r.x * inv),
        y: Math.round(r.y * inv),
        w: Math.round(r.w * inv),
        h: Math.round(r.h * inv)
      },
      displayId,
      // snappedWindowId tags the commit when the user clicked
      // straight from a window snap. Used by main for source-app
      // metadata even when fullWindow is false. Once the user
      // adjusts the rect (drag / resize) the windowId promise no
      // longer holds — the renderer leaves snap mode for adjusting,
      // and we don't include it.
      ...(fromWindowSnap ? { snappedWindowId: snap.entry.windowId } : {}),
      // fullWindow opts into the `screencapture -l <id>` path —
      // valid when (a) we have a windowId AND ⇧ is held at commit,
      // OR (b) the selector is in 'window' mode (always full-window
      // by definition). The default (no ⇧, mode='auto'|'region')
      // goes through the rect path, which captures whatever's
      // literally on screen including overlapping windows.
      ...(wantFull ? { fullWindow: true } : {})
    });
    setInteraction({ kind: "snap" });
    setSnapTarget({ kind: "display" });
    setRect(displaySnapRect());
  }

  // Reset the selector to live-snap mode WITHOUT submitting anything to
  // main. This is the "step back" half of the Escape behavior — purely
  // client-side, so it never triggers the main-side cancel choreography
  // (float-over cancel → hideSelector → previous-app reactivation).
  function resetToSnap(): void {
    setInteraction({ kind: "snap" });
    setSnapTarget({ kind: "display" });
    setRect(displaySnapRect());
    setShiftHeld(false);
    setSpaceHeld(false);
  }

  function cancel(): void {
    // The real exit: tell main to tear the selector down, then reset
    // local state so a re-shown (pre-warmed) window starts clean.
    window.pwrsnapApi?.submitRegion({ ok: false });
    resetToSnap();
  }

  // Single source of Escape semantics, called by BOTH the direct
  // keydown path and the forwarded-IPC path so they can't drift:
  //   - committed pick (anything but snap) → step back to snap, no submit
  //   - already in snap (nothing picked)   → exit (cancel → submit)
  // The escapeGuard swallows a second Escape within ESCAPE_DEDUPE_MS so
  // one physical press delivered via both paths can't step-back-then-
  // cancel. (Re-armed early by onMouseMove for snappy deliberate repeats.)
  function handleEscape(): void {
    if (escapeGuardRef.current) return;
    escapeGuardRef.current = true;
    setTimeout(() => {
      escapeGuardRef.current = false;
    }, ESCAPE_DEDUPE_MS);
    if (interactionRef.current.kind !== "snap") {
      resetToSnap();
    } else {
      cancel();
    }
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

    // True when the mousedown landed on a border move-band (the thin
    // inner-edge strips rendered while adjusting). Detected via the
    // element's `data-move` attribute, mirroring the `data-handle`
    // resize-handle pattern — so the 8 resize handles (z-index above
    // the bands) naturally win where they overlap an edge band.
    function isMoveBandTarget(target: EventTarget | null): boolean {
      return target instanceof HTMLElement && target.dataset.move !== undefined;
    }

    function lastCursor(): { x: number; y: number } {
      // Approximate cursor — onMouseMove keeps `lastMouseRef.current`
      // current; falls back to viewport center if we have nothing yet.
      const v = viewport();
      return lastMouseRef.current ?? { x: v.width / 2, y: v.height / 2 };
    }

    function onKeyDown(event: KeyboardEvent): void {
      // Track ⇧ in snap mode: full-window capture opt-in. The rect
      // expands from the visible-region bbox to the full window
      // bounds + the chip text changes + commit sends fullWindow:true.
      // Disabled in 'region' and 'window' modes — those modes have
      // explicit semantics; ⇧ is meaningless there.
      if (
        event.key === "Shift" &&
        !shiftRef.current &&
        modeRef.current === "auto" &&
        (interactionRef.current.kind === "snap" || interactionRef.current.kind === "pending")
      ) {
        const target = snapTargetRef.current;
        if (target.kind === "window") {
          setShiftHeld(true);
          setRect({
            x: target.entry.rawRect.x,
            y: target.entry.rawRect.y,
            w: target.entry.rawRect.w,
            h: target.entry.rawRect.h
          });
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        handleEscape();
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
        // on Shift+Tab.
        event.preventDefault();
        const cur = lastCursor();
        const all = windowsRef.current;
        const candidates = all.filter(
          (w) =>
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
        // Honor full-window mode: rect = rawRect (full bounds) when
        // ⇧ is held, else rect (visible region bbox).
        const r = shiftRef.current ? next.entry.rawRect : next.entry.rect;
        setRect({ x: r.x, y: r.y, w: r.w, h: r.h });
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
      if (event.key === "Shift" && shiftRef.current) {
        setShiftHeld(false);
        // Restore the visible-region rect when ⇧ is released — full-
        // window mode is opt-in only while the modifier is held.
        const target = snapTargetRef.current;
        if (
          target.kind === "window" &&
          (interactionRef.current.kind === "snap" || interactionRef.current.kind === "pending")
        ) {
          setRect({
            x: target.entry.rect.x,
            y: target.entry.rect.y,
            w: target.entry.rect.w,
            h: target.entry.rect.h
          });
        }
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

      // Adjusting → Space-held OR a border move-band = move. The
      // border band is the discoverable mouse affordance (interior drag
      // now redraws); Space+drag stays as the keyboard-modifier path.
      if (i.kind === "adjusting" && (spaceRef.current || isMoveBandTarget(event.target))) {
        setInteraction({
          kind: "moving",
          startMouse: { x: event.clientX, y: event.clientY },
          startRect: rectRef.current
        });
        return;
      }

      // Adjusting → interior mousedown NO LONGER moves the pick. It
      // stages a discard: a drag past threshold free-draws a brand-new
      // region (replace), a click-without-drag keeps the current
      // selection. We leave rect + snapTarget untouched, so the keep
      // case needs no restore — crucially NOT re-deriving via
      // rectForSnap, which would blow a free-drawn rect up to the whole
      // screen.
      if (i.kind === "adjusting" && isInsideCurrentRect(event.clientX, event.clientY)) {
        discardingRef.current = true;
        document.body.dataset.discarding = "true";
        // Fall through into pending below (snapAtPress carries the
        // current snap for any non-keep accounting).
      } else if (i.kind === "adjusting") {
        // Adjusting → click OUTSIDE the rect: drop to the snap under
        // the cursor (existing behavior). Not a discard-keep.
        const next = snapAt(event.clientX, event.clientY);
        setSnapTarget(next);
        setRect(rectForSnap(next));
        discardingRef.current = false;
        // Fall through into pending.
      }

      // From snap (or just-dropped/discarded-from-adjusting): start
      // pending. We don't transition to drawing yet — we wait to see if
      // the mouseup happens before DRAG_ENGAGE_PX of movement (= click)
      // or after (= free-draw).
      setInteraction({
        kind: "pending",
        startX: event.clientX,
        startY: event.clientY,
        snapAtPress: snapTargetRef.current
      });
    }

    function onMouseMove(event: MouseEvent): void {
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
      // Crosshair tracks the cursor in every state; CSS decides whether
      // it paints (hidden during moving/resizing and in window mode).
      positionCrosshair(event.clientX, event.clientY);
      // Moving the cursor re-arms the Escape de-dupe guard, so a
      // deliberate "step back, re-aim, Esc again to exit" feels instant.
      escapeGuardRef.current = false;
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
          // We use max-of-axes (Chebyshev) instead of Euclidean so a
          // 3px horizontal-only flick engages drag just as readily
          // as a 3px diagonal one. The previous `Math.hypot < 4`
          // gate was the main reason fast small drags felt sluggish:
          // a 3px single-axis movement read as a click-snap commit.
          const dx = event.clientX - i.startX;
          const dy = event.clientY - i.startY;
          if (!exceedsDragThreshold(dx, dy)) return;
          // Window mode never enters free-draw — the user is
          // picking a window, not a rect. Stay in pending; mouseup
          // will commit the window snap.
          if (modeRef.current === "window") return;
          // Cross — start drawing. A staged discard is now a committed
          // redraw: clear the discard-pending dim so the fresh
          // rubber-band draws at full strength.
          document.body.dataset.discarding = "false";
          discardingRef.current = false;
          // Override the snap rect with a free-draw rect anchored at the
          // original mousedown.
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
      // Any mouseup ends a staged discard-pending; clear the dim.
      document.body.dataset.discarding = "false";
      switch (i.kind) {
        case "pending": {
          // Click without drag → commit (or keep) the selection into
          // adjusting. The user can refine with handles + arrow keys +
          // ↵, or hit ↵ immediately to send.
          const snap = i.snapAtPress;
          const wasDiscard = discardingRef.current;
          discardingRef.current = false;
          if (!wasDiscard && snap !== null) {
            // Snap-mode / click-outside commit: bind to the snap target.
            setSnapTarget(snap);
            setRect(rectForSnap(snap));
          }
          // Interior "keep" click (wasDiscard): rect + snapTarget were
          // never changed since the press, so there is nothing to
          // restore — fall straight through to adjusting. (This is why
          // a free-drawn rect doesn't re-expand to the full display.)
          // Window mode: clicking on a window IS the commit. Skip
          // adjusting and submit immediately. We re-set rect
          // synchronously off `snap` so commit() reads the window's
          // bounds rather than whatever the previous adjusting rect was.
          // (Window mode has no adjusting state, so stash is always null
          // here.)
          if (modeRef.current === "window" && snap !== null && snap.kind === "window") {
            const r = rectForSnap(snap);
            rectRef.current = r;
            snapTargetRef.current = snap;
            commit();
            return;
          }
          setInteraction({ kind: "adjusting" });
          return;
        }
        case "drawing": {
          const r = rectRef.current;
          // Once we entered `drawing` the user has expressed drag
          // intent (they crossed the threshold). Don't second-guess
          // and revert to snap on a thin rect: a horizontal strip
          // (200×1) is a legitimate selection. Only reject zero-area
          // rects, which can only happen on a pathological no-move
          // mouseup that somehow reached this branch.
          if (!rectIsMeaningful(r)) {
            // Defensive — shouldn't reach here under normal use.
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
    // Globally-forwarded keystrokes (main → renderer over IPC).
    // macOS sometimes withholds keyboard events from a freshly-shown
    // window until the user clicks to "engage" it. main arms a
    // globalShortcut on Esc + ↵ for the duration of the selector
    // and forwards them here, so cancel / commit work on first
    // keypress regardless of whether the renderer has caught
    // keyboard focus yet.
    const unsubKey = window.pwrsnapApi?.onSelectorKey((payload) => {
      if (payload.key === "Escape") {
        handleEscape();
      } else if (payload.key === "Enter") {
        commit();
      }
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      unsubKey?.();
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
      // Region mode: pure rect drag. No window snap, no ⇧.
      if (mode === "region") {
        return (
          <>
            <span>
              <kbd>drag</kbd>region
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>↵</kbd>commit
            </span>
          </>
        );
      }
      // Window mode: click commits the highlighted window. No drag,
      // no ⇧ (full-window is implied).
      if (mode === "window") {
        const what =
          snapTarget.kind === "window"
            ? snapTarget.entry.appName ?? "window"
            : "—";
        return (
          <>
            <span>
              <kbd>click</kbd>capture {what}
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>tab</kbd>next window
            </span>
          </>
        );
      }
      // Auto mode (default ⌘⇧P).
      const what =
        snapTarget.kind === "window"
          ? snapTarget.entry.appName ?? "window"
          : "display";
      const isFullWindow = shiftHeld && snapTarget.kind === "window";
      return (
        <>
          <span>
            <kbd>click</kbd>
            {isFullWindow ? `capture full ${what}` : `capture ${what}`}
          </span>
          {snapTarget.kind === "window" && !shiftHeld && (
            <>
              <span className="region-hint-sep">·</span>
              <span>
                <kbd>⇧</kbd>full window
              </span>
            </>
          )}
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
            <kbd>drag</kbd>redraw
          </span>
          <span className="region-hint-sep">·</span>
          <span>
            <kbd>arrows</kbd>nudge (<kbd>⇧</kbd>×10)
          </span>
          <span className="region-hint-sep">·</span>
          <span>
            <kbd>border</kbd>move
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
      {/* Cursor-tracking crosshair guide-lines. Positioned by direct
          DOM writes (positionCrosshair); CSS gates visibility off
          body[data-interaction] + body[data-mode]. pointer-events:none
          so the window-level listeners still see every event. */}
      <div ref={hLineRef} className="region-crosshair region-crosshair-h" data-testid="region-crosshair-h" />
      <div ref={vLineRef} className="region-crosshair region-crosshair-v" data-testid="region-crosshair-v" />
      {/* Frozen-screen snapshot — full-window background.  The
          renderer is interacting with this image, not the live
          screen.  Drawn first so the dim mask + rect sit on top.
          Sized to fill the window via inline styles to avoid waiting
          on a CSS bundle hot-reload during dev. */}
      {screenUrl !== null && (
        <img
          src={screenUrl}
          alt=""
          draggable={false}
          style={{
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "fill",
            // Critical: don't intercept mouse events. The selector's
            // window-level keydown / mousedown listeners need to see
            // every event regardless of where in the window the
            // cursor is.
            pointerEvents: "none",
            // Safety: place behind the dim quadrants + rect overlay.
            // (region-dim sits above this in DOM order; z-index 0
            // here pins it as the floor.)
            zIndex: 0,
            userSelect: "none"
          }}
        />
      )}
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
            {/* Border move-bands: dragging an edge moves the selection
                (interior drag redraws instead). Resize handles sit on
                top (z-index) and win where they overlap. */}
            <div className="region-move-band top" data-move="top" />
            <div className="region-move-band right" data-move="right" />
            <div className="region-move-band bottom" data-move="bottom" />
            <div className="region-move-band left" data-move="left" />
            {ALL_HANDLES.map((h) => (
              <span key={h} className={`region-handle ${h}`} data-handle={h} />
            ))}
          </>
        )}
      </div>

      {dimsChipPosition !== null && (
        <div
          className="region-dims-chip"
          data-intent={intent}
          style={{
            left: dimsChipPosition.left,
            top: dimsChipPosition.top,
            ...(intent === "video"
              ? {
                  background: "rgba(239, 68, 68, 0.95)",
                  color: "#fff",
                  borderColor: "rgba(255, 255, 255, 0.25)"
                }
              : {})
          }}
        >
          {intent === "video" && (
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "#fff",
                marginRight: 6,
                verticalAlign: "middle",
                animation: "ps-rec-pulse 1.2s ease-in-out infinite"
              }}
            />
          )}
          {intent === "video" && <strong style={{ marginRight: 6 }}>RECORD</strong>}
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
        {intent === "video" && (
          <>
            <span>
              <kbd>click / drag</kbd>start recording
            </span>
            <span className="region-hint-sep">·</span>
          </>
        )}
        {hint}
        <span className="region-hint-sep">·</span>
        <span>
          {/* Single source of the Esc affordance. In a committed pick
              Esc steps back ("back"); in snap it exits ("cancel"). */}
          <kbd>esc</kbd>
          {interaction.kind === "adjusting" ? "back" : "cancel"}
        </span>
      </div>
      <style>{`@keyframes ps-rec-pulse {
        0% { opacity: 1; }
        50% { opacity: 0.4; }
        100% { opacity: 1; }
      }`}</style>
    </div>
  );
}
