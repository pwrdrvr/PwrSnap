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
//     A rect has been committed (by drag-end, by ↵ from snap, or by
//     nudging a lone pick). Handles are live, drag-to-move works,
//     arrow keys nudge, ⇧+arrow nudges by 10px. ↵ submits to main;
//     esc steps back. mousedown outside the rect drops back to snap.
//
//   moving / resizing:
//     Sub-states of adjusting; mouse drives translation / edge drag.
//
// Orthogonal to all of the above is the PICK SET (`picks`): the
// windows a click has accumulated in `auto` and `window` mode.
// `togglePick` parks the interaction in `snap` while a set is live,
// because the frame is then the set's union and handles/nudge do not
// apply to it — so `interaction.kind` alone does NOT describe the
// selector, and anything reading it (Escape, the hint bar, a new
// gesture) must consult `picksRef` too.
//
// There are two commit routes, not one: a pick set submits straight
// from `snap`, and everything else lands in `adjusting` first so the
// user can refine before it goes through.
//
// Coords reported to main are in window-local px (= display-local;
// the selector window covers the whole display). Main converts to
// global virtual coords + display id before screencapture.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { acceleratorToDisplayKeys, MAX_SELECTOR_EXTENTS } from "@pwrsnap/shared";
import type { WindowSnapEntry } from "../../preload-types";
import { rendererShortcutPlatform } from "../../lib/shortcut-platform";
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
// deliberate second press. Timer-only — NOT re-armed on mousemove (a
// stray cursor move must not be able to defeat the de-dupe).
const ESCAPE_DEDUPE_MS = 50;

type SnapTarget =
  | { kind: "window"; entry: WindowSnapEntry }
  | { kind: "display" };

type SelectorMode = "auto" | "region" | "window";

/** Output shape for a multi-window pick. See the `outputMode` state. */
type OutputMode = "windows" | "rectangle";

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

/**
 * Union bounding box of a multi-window pick, in CSS px.
 *
 * `rawRect` (full window bounds), not `rect` (visible-region bbox), is
 * the right source: an extent is the rectangle the window occupies on
 * screen, and the capture keeps whatever is composited inside it. Using
 * the visible-region bbox would shrink the extent around an occluder
 * and cut off parts of the window the user can plainly see.
 */
function unionOfPicks(entries: readonly WindowSnapEntry[]): Rect | null {
  if (entries.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const e of entries) {
    left = Math.min(left, e.rawRect.x);
    top = Math.min(top, e.rawRect.y);
    right = Math.max(right, e.rawRect.x + e.rawRect.w);
    bottom = Math.max(bottom, e.rawRect.y + e.rawRect.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function RegionSelector() {
  const shiftKey =
    acceleratorToDisplayKeys("Shift", rendererShortcutPlatform())[0] ?? "Shift";
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
  //   - 'auto'   — click picks windows (repeatable), drag free-draws a
  //                region, ⇧ → full-window; ↵ commits
  //   - 'region' — pure rect drag; snap candidates are suppressed; ⇧
  //                does nothing; multi-select is off
  //   - 'window' — pure window picker; same click-to-pick model as
  //                'auto' but drag-to-region is suppressed and every
  //                pick is full-window
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
  // Video-only: whether the recording bakes in the mouse cursor.
  // Seeded from `settings.recording.videoCaptureCursor` via the mode
  // signal on every show (so a prior capture's flip never leaks through
  // the pre-warmed window), flipped with the `C` key, and shipped on the
  // commit payload for the hotkey path to pass to `recording:start`.
  const [captureCursor, setCaptureCursor] = useState(true);
  // ⇧ in snap mode opts into full-window capture: the rect expands
  // from the visible-region bounding box (`entry.rect`) to the
  // window's full bounds (`entry.rawRect`), and the commit payload
  // carries fullWindow:true so main routes to `screencapture -l`.
  // Default (no ⇧) is rect capture — what's literally on screen
  // including any overlapping content.
  const [shiftHeld, setShiftHeld] = useState(false);
  // Multi-window pick. Ordered by the order the user clicked, so the
  // badges and the HUD chips stay stable while they add and remove.
  // Empty array = the classic single-target flow, byte-for-byte
  // unchanged; every multi-select branch below is gated on length > 0.
  //
  // A pick is an EXTENT — the window's bounds on the frozen screen —
  // not a request for that window's own backing buffer. Whatever was
  // composited on top of it at freeze time is inside the extent and
  // will be in the capture. That is the whole model; see
  // `cropScreenSnapshotExtents` in capture-handlers.ts.
  const [picks, setPicks] = useState<readonly WindowSnapEntry[]>([]);
  // What to keep inside the union box of `picks`:
  //   'windows'   — only the extents; everything between them goes
  //                 transparent. The default, and the reason the HUD
  //                 exists.
  //   'rectangle' — the whole box, opaque. What a rect capture has
  //                 always produced.
  const [outputMode, setOutputMode] = useState<OutputMode>("windows");

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
  const picksRef = useRef<readonly WindowSnapEntry[]>([]);
  // The window under the current mousedown, if that press could still
  // turn out to be a pick. Set on mousedown, cleared the moment the
  // gesture becomes a drag, consumed on mouseup. This ref is the whole
  // reason a plain click can pick a window without costing the region
  // drag: on press we do not yet know which the user meant, so we
  // commit to neither until the button comes back up.
  const pendingPickRef = useRef<WindowSnapEntry | null>(null);
  // Latched by the first `submitRegion` of a show, cleared by the next
  // mode signal. Main arms BOTH Escape and Return as global shortcuts
  // and forwards them, so a single physical ↵ can arrive twice — once
  // as a renderer keydown, once over IPC. Escape already carries
  // `ESCAPE_DEDUPE_MS` for exactly this; commit carried nothing, and
  // the second delivery ran against the state the first one had
  // already reset, so it submitted the whole display. Only main's
  // `pendingResolver === null` check stood between a duplicate
  // keystroke and a full-screen capture.
  const submittedRef = useRef(false);
  const outputModeRef = useRef<OutputMode>("windows");
  const modeRef = useRef<SelectorMode>("auto");
  const intentRef = useRef<"snap" | "video">("snap");
  const captureCursorRef = useRef(true);
  // Cursor-tracking crosshair guide-lines (auto/region modes). Rendered
  // once and repositioned by direct DOM writes from `onMouseMove` /
  // the window-list cursor — never via React state, so they impose no
  // re-render cost in `adjusting` (where onMouseMove early-returns).
  // Visibility is gated entirely in CSS off body[data-interaction] +
  // body[data-mode]; see region.css.
  const hLineRef = useRef<HTMLDivElement | null>(null);
  const vLineRef = useRef<HTMLDivElement | null>(null);
  // Guards handleEscape against a double-delivered single Esc press
  // (focused-renderer keydown + forwarded globalShortcut IPC). Armed on
  // the first Escape, auto-disarmed after ESCAPE_DEDUPE_MS — long enough
  // to swallow the near-simultaneous duplicate, far shorter than any
  // deliberate second press. escapeTimerRef holds the disarm timer so it
  // can be cleared on unmount / rescheduled.
  const escapeGuardRef = useRef(false);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  intentRef.current = intent;
  captureCursorRef.current = captureCursor;
  picksRef.current = picks;
  outputModeRef.current = outputMode;

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
    // Multi-select is on: the HUD owns the bottom of the screen, so
    // CSS lifts the hint bar clear of it. Also used by E2E to assert
    // the pick set without reaching into React state.
    // One attribute, not two: `has-picks` was exactly
    // `pick-count !== "0"`, and two encodings of one fact can disagree.
    document.body.dataset.pickCount = String(picks.length);
    document.body.dataset.outputMode = outputMode;
  }, [interaction.kind, spaceHeld, snapTarget, shiftHeld, mode, picks, outputMode]);

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
      // Re-seed the cursor toggle from the persisted default each show
      // (defaults ON when unset) so a prior capture's choice can't bleed
      // into this one through the reused, pre-warmed selector window.
      setCaptureCursor(payload.cursor ?? true);
      // Drop the pick set on EVERY show. This handler is the only
      // per-show reset the renderer gets, and main can end a session
      // without one: `pickRegion` resolves an in-flight resolver with
      // `cancelled` and re-shows the same pre-warmed window. Without
      // this, a set built in an abandoned session survives into the
      // next capture — the HUD paints over a video picker, `commit()`
      // ships the old windows' extents, and in `region` mode (where
      // multi-select is off) the user cannot even click them away.
      picksRef.current = [];
      setPicks([]);
      setOutputMode("windows");
      // An armed pick belongs to the session that pressed the button.
      // Clearing it here is what stops a press made under the previous
      // mode from landing as a pick under the new one — `region` mode
      // and video intent have no multi-select to land it in.
      pendingPickRef.current = null;
      // A new show is a new submission window.
      submittedRef.current = false;
      // Everything below is the rest of a per-show reset, and it has to
      // be here rather than only in `resetToSnap`: main can end a
      // session WITHOUT a renderer commit or cancel (`pickRegion`
      // resolves an in-flight resolver with `cancelled` and re-shows
      // the same pre-warmed window), and on Windows/Linux the panel is
      // never destroyed, so this handler is the only reset the renderer
      // gets. Leaving these behind meant:
      //   - `interaction` stayed `adjusting`, so the previous
      //     session's rect was still armed and ↵ shipped it (dropping
      //     the pick set was not enough — `togglePick` had already
      //     written the union into `rect`);
      //   - a still-held `pending` survived, and one bare mousemove
      //     then promoted it to `drawing` with no button down;
      //   - `shiftHeld` / `spaceHeld` latched, so the next show opened
      //     with full-window armed or the grab cursor up;
      //   - a staged discard kept the rect dimmed at 40%.
      setInteraction({ kind: "snap" });
      setShiftHeld(false);
      setSpaceHeld(false);
      clearDiscardPending();
      // The rect + snap target are re-derived from the cursor on the
      // first mousemove or window-list snapshot, but until one arrives
      // the previous session's frame would still be showing (and
      // committable), so seed them from the display now. `region` mode
      // additionally has no window snapping at all.
      setSnapTarget({ kind: "display" });
      setRect(displaySnapRect());
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
        setSnapRect(rectForSnap(next));
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

  /**
   * Set the rect from a snap target.
   *
   * No-op while a pick set owns the frame: the rect is then the union
   * of the picks, and hovering another window must keep updating the
   * highlight (so "click to add" reads) without stomping it.
   */
  function setSnapRect(r: Rect): void {
    if (picksRef.current.length > 0) return;
    rectRef.current = r;
    setRect(r);
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

  /**
   * True when multi-select is available at all.
   *
   * Video is excluded on purpose: a recording is one rectangular
   * stream, so a disjoint set of extents has nothing to mean there.
   * Offering the affordance and then silently flattening it to a
   * bounding box would be a lie.
   */
  function multiSelectAllowed(): boolean {
    return intentRef.current !== "video" && modeRef.current !== "region";
  }

  /**
   * Drop the pick set WITHOUT touching the rect.
   *
   * The counterpart to `togglePick`'s empty branch, which re-derives
   * the rect from the cursor's snap. This one is for the gestures that
   * supply their own rect — free-draw, move, resize — where snapping
   * back would undo the very gesture that cleared the set. After this
   * the selection is a plain rect, so `commit()` takes the rect path
   * and the hand-adjusted geometry is what ships.
   */
  function clearPickSet(): void {
    if (picksRef.current.length === 0) return;
    picksRef.current = [];
    setPicks([]);
    outputModeRef.current = "windows";
    setOutputMode("windows");
  }

  /**
   * Return to live snap, re-deriving the frame from whatever is under
   * the cursor.
   *
   * NOT the same as `resetToSnap`, which hard-sets the display rect.
   * Emptying a pick set has to land here: the user dropped a
   * selection, not the session, and snapping to the whole display
   * would turn the very next ↵ into a full-screen capture. Shared by
   * `togglePick`'s empty branch and Escape's pick branch so those two
   * routes out of a pick set cannot land in different places.
   */
  function dropToLiveSnap(): void {
    setInteraction({ kind: "snap" });
    const cursor = lastMouseRef.current;
    const snap =
      cursor === null ? ({ kind: "display" } as SnapTarget) : snapAt(cursor.x, cursor.y);
    setSnapTarget(snap);
    snapTargetRef.current = snap;
    const r = rectForSnap(snap);
    rectRef.current = r;
    setRect(r);
  }

  /**
   * Add or remove a window from the pick set, and re-derive the rect
   * from what's left. Emptying the set drops straight back to live
   * snap, so there is no "selected nothing" dead end.
   */
  function togglePick(entry: WindowSnapEntry): void {
    const current = picksRef.current;
    const removing = current.some((p) => p.windowId === entry.windowId);
    // Main's payload validator rejects the WHOLE payload past this
    // bound, and a rejected payload resolves the session as
    // `cancelled` — so without this the 65th pick did not fail loudly,
    // it silently discarded the capture at commit time, looking exactly
    // like an Escape. Refuse the add instead; removals always proceed.
    if (!removing && current.length >= MAX_SELECTOR_EXTENTS) return;
    const next = removing
      ? current.filter((p) => p.windowId !== entry.windowId)
      : [...current, entry];
    picksRef.current = next;
    setPicks(next);
    // Below two picks the union box IS the extent, so the output-shape
    // control and the `T` binding both disappear. Snap back to the
    // default or the user is stranded in `rectangle` with no key and no
    // button to leave it — and the next pick they add inherits it.
    if (next.length < 2) {
      outputModeRef.current = "windows";
      setOutputMode("windows");
    }
    const union = unionOfPicks(next);
    if (union === null) {
      // Last pick removed — back to live snap under the cursor.
      dropToLiveSnap();
      return;
    }
    // The union box IS the rect from here on: it is what a RECTANGLE
    // commit captures, what `rectIsMeaningful` gates on, and what main
    // validates. `extents` rides alongside it as the mask.
    rectRef.current = union;
    setRect(union);
    // Multi-select owns the frame; handles and nudge don't apply to a
    // derived union, so park the interaction in snap and let the pick
    // set drive.
    setInteraction({ kind: "snap" });
  }

  function commit(): void {
    if (submittedRef.current) return;
    // The renderer's rects are in CSS pixels. Main + screencapture
    // expect display-logical pixels. Scale back via the inverse of the
    // snapshot's css-to-logical factor. On standard displays this is
    // 1.0 — no-op. On scaled-mode Retina (e.g. inner=1460 logical=1920)
    // it's ~1.315 and corrects the doubling we'd otherwise see in the
    // captured PNG. ONE definition, used by every commit route — this
    // is the most bug-prone arithmetic in the file and a second copy
    // could be fixed while the first stayed wrong.
    const inv = cssToLogicalRef.current > 0 ? 1 / cssToLogicalRef.current : 1;
    // The far edge is ROUNDED, not derived as `round(x) + round(w)` —
    // the same rule `toPhysical` follows in extent-mask.ts, for the
    // same reason: at a fractional factor the two differ whenever the
    // fractions carry.
    //
    // Measured, this changes nothing for EXTENTS: they come only from
    // the window list, which main sends as integer logical px and this
    // renderer scales by `cssToLogicalRef`, so multiplying by its exact
    // reciprocal here recovers the original integers under either rule
    // (0 divergences across 12040 sampled geometries at four scale
    // factors). It differs only for a FREE-DRAWN rect, whose CSS
    // coordinates are arbitrary — and there the far edge is where the
    // user released the button, which is what this computes. Kept
    // because one rounding rule across the two layers is worth more
    // than the ≤1px it moves.
    const toLogical = (r: Rect): Rect => {
      const x = Math.round(r.x * inv);
      const y = Math.round(r.y * inv);
      return {
        x,
        y,
        w: Math.max(1, Math.round((r.x + r.w) * inv) - x),
        h: Math.max(1, Math.round((r.y + r.h) * inv) - y)
      };
    };
    // Multi-window pick wins over the single-target path when the user
    // has one. Its rect is the union box, so everything downstream in
    // main — validation, source-app resolution, cursor placement —
    // behaves exactly as it does for a plain rect capture.
    // Re-check the capability, don't just trust that the pick set could
    // only have been built where multi-select is allowed. A set can
    // outlive the mode it was built in (main re-shows this pre-warmed
    // window with a new mode signal), and shipping `extents` on a video
    // commit would record the bounding box of windows the user picked
    // in an abandoned session and never re-confirmed.
    const activePicks = multiSelectAllowed() ? picksRef.current : [];
    if (activePicks.length > 0) {
      const union = unionOfPicks(activePicks);
      if (union === null || !rectIsMeaningful(union)) {
        cancel();
        return;
      }
      // A pick set of ONE is still the old single-window capture, and
      // in the two places that mean "full window" — `window` mode, and
      // ⇧ in auto mode — it must keep routing to the backing-buffer
      // path so a covered window still comes out whole. Masking is a
      // crop of the frozen screen and cannot do that. With 2+ picks
      // there is no backing-buffer option, so the mask is the only
      // answer and the mode question disappears.
      if (activePicks.length === 1) {
        const only = activePicks[0]!;
        const wantFull = modeRef.current === "window" || shiftRef.current;
        submittedRef.current = true;
        window.pwrsnapApi?.submitRegion({
          ok: true,
          rect: toLogical(only.rawRect),
          displayId,
          snappedWindowId: only.windowId,
          // No `extents`. A one-window mask covers its own union box
          // edge to edge, so it can only ever produce the same pixels
          // as the plain crop — at the cost of a decode + composite in
          // main. Sending the rect alone keeps a single-window Quick
          // Capture byte-identical to what it has always been.
          ...(wantFull ? { fullWindow: true } : {})
        });
        resetToSnap();
        return;
      }
      submittedRef.current = true;
      window.pwrsnapApi?.submitRegion({
        ok: true,
        rect: toLogical(union),
        displayId,
        extents: activePicks.map((p) => toLogical(p.rawRect)),
        outputMode: outputModeRef.current,
        // The first pick names the capture's source app. Without it a
        // multi-window union's centre often lands on empty desktop and
        // the record gets no source app at all.
        snappedWindowId: activePicks[0]!.windowId
      });
      resetToSnap();
      return;
    }
    const r = rectRef.current;
    // Refuse to submit only when the rect has truly zero usable area
    // (no real drag happened). A long thin strip — e.g. 200×1 to grab
    // a status bar — is a legitimate user intent and should commit.
    if (!rectIsMeaningful(r)) {
      cancel();
      return;
    }
    const snap = snapTargetRef.current;
    // A "window snap commit" can happen from any interaction state
    // when we have a window snap target — not just live `snap`. In
    // window-mode the user clicks once, the pending → adjusting flow
    // commits with snap=window even after the brief mouseup.
    const fromWindowSnap = snap.kind === "window";
    // `screencapture -l` captures the window's own backing buffer and
    // NEVER reads `rect`, so opting into it is only honest while the
    // rect still IS the window. Once the user has nudged or resized it
    // — which the arrow-key promotion now makes reachable in `window`
    // mode, where every commit would otherwise take that path — the
    // full-window route would silently throw the adjustment away and
    // return the un-nudged window.
    const rectIsWholeWindow =
      fromWindowSnap &&
      r.x === snap.entry.rawRect.x &&
      r.y === snap.entry.rawRect.y &&
      r.w === snap.entry.rawRect.w &&
      r.h === snap.entry.rawRect.h;
    const wantFull =
      rectIsWholeWindow && (shiftRef.current || modeRef.current === "window");
    submittedRef.current = true;
    window.pwrsnapApi?.submitRegion({
      ok: true,
      rect: toLogical(r),
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
      ...(wantFull ? { fullWindow: true } : {}),
      // Video-only: the cursor choice for this recording. Read from the
      // ref (not state) because this commit closure is captured once at
      // mount by the global keydown listener. Omitted for image
      // captures, which don't consume it yet (Phase 3).
      ...(intentRef.current === "video"
        ? { captureCursor: captureCursorRef.current }
        : {})
    });
    // Full reset, same as the pick path above. Hand-rolling a partial
    // one here left `shiftHeld` / `spaceHeld` latched: the ⇧ keyup is
    // lost once main hides the window, so the next show of this
    // pre-warmed selector started with full-window armed and a bare ↵
    // shipped `fullWindow: true` again.
    resetToSnap();
  }

  // Reset the selector to live-snap mode WITHOUT submitting anything to
  // main. This is the "step back" half of the Escape behavior — purely
  // client-side, so it never triggers the main-side cancel choreography
  // (float-over cancel → hideSelector → previous-app reactivation).
  // Clear any staged discard-pending state (the ref + the CSS dim). Safe
  // to call from any reset path; idempotent.
  function clearDiscardPending(): void {
    discardingRef.current = false;
    document.body.dataset.discarding = "false";
  }

  function resetToSnap(): void {
    setInteraction({ kind: "snap" });
    setSnapTarget({ kind: "display" });
    setRect(displaySnapRect());
    setShiftHeld(false);
    setSpaceHeld(false);
    // Drop the pick set too. The selector windows are pre-warmed and
    // reused, so anything left here would surface on the next show.
    picksRef.current = [];
    setPicks([]);
    setOutputMode("windows");
    // Same for an armed-but-unreleased pick: ↵ can commit while the
    // button is still down, and the press must not outlive the
    // selection it was part of.
    pendingPickRef.current = null;
    // A reset can interrupt a staged discard (Esc held during pending);
    // drop the dim + flag so they don't survive into the next gesture or
    // the next show of this pre-warmed window.
    clearDiscardPending();
  }

  function cancel(): void {
    if (submittedRef.current) return;
    // The real exit: tell main to tear the selector down, then reset
    // local state so a re-shown (pre-warmed) window starts clean.
    submittedRef.current = true;
    window.pwrsnapApi?.submitRegion({ ok: false });
    resetToSnap();
  }

  // Single source of Escape semantics, called by BOTH the direct
  // keydown path and the forwarded-IPC path so they can't drift:
  //   - committed pick (anything but snap) → step back to snap, no submit
  //   - already in snap (nothing picked)   → exit (cancel → submit)
  // The escapeGuard swallows a second Escape within ESCAPE_DEDUPE_MS so a
  // single physical press delivered via both paths can't step-back-then-
  // cancel. The window is far shorter than any deliberate second press,
  // so "Esc, Esc to exit" still works; it is NOT re-armed on mousemove —
  // a stray cursor move must not be able to defeat the de-dupe.
  function handleEscape(): void {
    if (escapeGuardRef.current) return;
    escapeGuardRef.current = true;
    if (escapeTimerRef.current !== null) clearTimeout(escapeTimerRef.current);
    escapeTimerRef.current = setTimeout(() => {
      escapeGuardRef.current = false;
      escapeTimerRef.current = null;
    }, ESCAPE_DEDUPE_MS);
    // A pick set is a committed selection, exactly like an adjusting
    // rect: the first Escape drops it, a second one exits. Checked
    // before the interaction kind because togglePick parks the
    // interaction in `snap` while picks are live.
    if (picksRef.current.length > 0) {
      // Drop the SET, not the session — and land where removing the
      // last chip lands. `resetToSnap()` hard-sets the display rect,
      // so Escaping a lone pick used to leave the whole screen armed
      // and the very next ↵ captured it.
      clearPickSet();
      dropToLiveSnap();
      clearDiscardPending();
      return;
    }
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
      // explicit semantics; ⇧ is meaningless there. Also disabled once
      // a pick set exists: the rect is then the derived union, and
      // `setSnapRect` refuses to overwrite it (so a raw `setRect` here
      // would corrupt it with no way back).
      if (
        event.key === "Shift" &&
        !shiftRef.current &&
        modeRef.current === "auto" &&
        picksRef.current.length === 0 &&
        (interactionRef.current.kind === "snap" || interactionRef.current.kind === "pending")
      ) {
        const target = snapTargetRef.current;
        if (target.kind === "window") {
          setShiftHeld(true);
          setSnapRect({
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
      if ((event.key === "t" || event.key === "T") && picksRef.current.length > 1) {
        // Flip the output shape. Only bound at two or more picks: with
        // one, the union box IS the extent, so both modes produce the
        // same pixels and the key would be a no-op the user could not
        // explain.
        event.preventDefault();
        setOutputMode((prev) => (prev === "windows" ? "rectangle" : "windows"));
        return;
      }
      if (
        (event.key === "c" || event.key === "C") &&
        intentRef.current === "video"
      ) {
        // Video-only: toggle whether the recording bakes in the mouse
        // cursor. The hint bar reflects the current state; the value
        // rides the commit payload to `recording:start`.
        event.preventDefault();
        setCaptureCursor((prev) => !prev);
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
        setSnapRect({ x: r.x, y: r.y, w: r.w, h: r.h });
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
      // Arrow-key nudge. Normally only while adjusting (no live drag)
      // — but a LONE pick promotes into adjusting on the first arrow.
      // Clicking a window used to land in `adjusting` directly, so the
      // arrows moved it; now a click picks, and without this the keys
      // would be silently dead on the very selection they used to
      // nudge. The rect is already the pick's box, so promoting is just
      // dropping the pick (see clearPickSet) and pinning the snap
      // target to the window that was picked — NOT to whatever the
      // cursor has since wandered over, which would tag the commit with
      // the wrong `snappedWindowId`.
      //
      // Not offered above one pick: the rect is a derived union there,
      // and nudging it would leave the extents pinned to windows the
      // box no longer matches.
      const isArrowKey =
        event.key === "ArrowLeft" ||
        event.key === "ArrowRight" ||
        event.key === "ArrowUp" ||
        event.key === "ArrowDown";
      if (interactionRef.current.kind !== "adjusting") {
        if (!isArrowKey) return;
        if (interactionRef.current.kind !== "snap") return;
        if (picksRef.current.length !== 1) return;
        const only = picksRef.current[0]!;
        clearPickSet();
        const promoted: SnapTarget = { kind: "window", entry: only };
        snapTargetRef.current = promoted;
        setSnapTarget(promoted);
        setInteraction({ kind: "adjusting" });
      }
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
          setSnapRect({
            x: target.entry.rect.x,
            y: target.entry.rect.y,
            w: target.entry.rect.w,
            h: target.entry.rect.h
          });
        }
      }
    }

    /**
     * The window this mousedown would pick, or null if the press is
     * not a pick candidate at all.
     *
     * Called on mousedown, but deliberately does NOT act: the answer
     * is stashed and only consumed if the button comes back up without
     * the pointer travelling far enough to be a drag. That deferral is
     * what lets Quick Capture bind a plain click to "pick this window"
     * while a plain drag still free-draws a region — on press those two
     * gestures are indistinguishable, and in `auto` mode almost every
     * region drag starts on top of some window, so resolving the
     * ambiguity eagerly has to sacrifice one of them. It used to
     * sacrifice picking: `auto` required ⌘-click, which meant the
     * headline capture path could not pick a second window at all.
     *
     *   - `window` mode: every press over a window is a candidate.
     *   - `auto` mode: likewise. A modifier is no longer required —
     *     ⌘/⌃ still work, since they change nothing about a press that
     *     is already a candidate.
     *   - `region` mode and video intent: never (see
     *     multiSelectAllowed).
     */
    function pickCandidateFor(event: MouseEvent): WindowSnapEntry | null {
      if (!multiSelectAllowed()) return null;
      // Prefer the LIVE SNAP TARGET when the press lands inside it.
      // `findWindowAt` returns the frontmost window at the point, but
      // Tab exists precisely to reach a window buried under another —
      // it moves `snapTargetRef` without moving the cursor, so a bare
      // re-hit-test would highlight the buried window and then pick the
      // one on top of it. In `window` mode Tab is the ONLY way to reach
      // an occluded window, and the hint advertises it in both modes.
      const snap = snapTargetRef.current;
      if (
        snap.kind === "window" &&
        isPointInsideRect(snap.entry.rawRect, event.clientX, event.clientY)
      ) {
        return snap.entry;
      }
      return findWindowAt(event.clientX, event.clientY);
    }

    function onMouseDown(event: MouseEvent): void {
      if (event.button !== 0) return;
      // The HUD is the one region of the overlay that owns its own
      // clicks. Bail before preventDefault so the button receives
      // focus and its onClick fires normally; treating a HUD press as
      // a canvas gesture would toggle a pick under the bar.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-region-hud]") !== null
      ) {
        return;
      }
      event.preventDefault();
      const handle = getHandleFromTarget(event.target);
      const i = interactionRef.current;

      // Multi-select intercept. It sits ahead of the SNAP/DRAW branches
      // — a pick is not a discard — but BEHIND the adjusting
      // affordances below: a press on a resize handle or a border
      // move-band is unambiguously a gesture on the committed rect, and
      // a window almost always lies under those few pixels, so
      // intercepting first made handles and move-bands unusable.
      const onAdjustAffordance =
        i.kind === "adjusting" &&
        (handle !== null ||
          spaceRef.current ||
          isMoveBandTarget(event.target) ||
          // A press INSIDE a committed rect belongs to that rect — it
          // stages the discard/keep below. Letting the pick intercept
          // take it destroyed the selection outright: a window sits
          // under almost every rect in `auto` mode, so a single click
          // anywhere inside a free-drawn or hand-resized region
          // replaced it with that window's bounds, with no undo and
          // with the hint still advertising only `drag redraw`.
          isInsideCurrentRect(event.clientX, event.clientY));
      pendingPickRef.current = null;
      if (!onAdjustAffordance) {
        const hit = pickCandidateFor(event);
        if (hit !== null) {
          // Arm the pick and go straight to `pending`. We deliberately
          // skip the adjusting branches below — in particular the
          // interior "staged discard", which would dim the rect for a
          // press that is about to become a pick. If the pointer
          // travels, `pending` promotes to `drawing` and the armed pick
          // is dropped; if it doesn't, mouseup consumes it.
          pendingPickRef.current = hit;
          setInteraction({
            kind: "pending",
            startX: event.clientX,
            startY: event.clientY,
            snapAtPress: snapTargetRef.current
          });
          return;
        }
        // Pressed the desktop with picks live. Go to `pending` with no
        // snap captured: a click keeps the set (mouseup's picks guard
        // below), a drag past threshold replaces it with a free-drawn
        // region. Returning outright here — the previous behavior —
        // kept the set safe but also made it impossible to START a
        // region drag from empty desktop once anything was picked.
        if (picksRef.current.length > 0) {
          setInteraction({
            kind: "pending",
            startX: event.clientX,
            startY: event.clientY,
            snapAtPress: null
          });
          return;
        }
      }

      // Adjusting → handle drag = resize. A pick set parks the
      // interaction in `snap`, so it cannot currently be live here;
      // the clear is belt-and-braces so that a hand-adjusted rect can
      // never lose to stale extents at commit if that ever changes.
      if (handle !== null && i.kind === "adjusting") {
        clearPickSet();
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
        clearPickSet();
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
      // Over the HUD there is nothing to aim at — the bar covers
      // whatever is behind it. Freeze the highlight rather than
      // snapping to a window the user can't see under the toolbar, and
      // bail BEFORE recording the position: `lastMouseRef` is what
      // `togglePick` hit-tests from when the set empties and what Tab
      // cycles from, so letting it hold a HUD coordinate makes removing
      // the last chip snap to whatever sits behind the toolbar.
      if (
        picksRef.current.length > 0 &&
        event.target instanceof HTMLElement &&
        event.target.closest("[data-region-hud]") !== null
      ) {
        return;
      }
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
      // Crosshair tracks the cursor in every state; CSS decides whether
      // it paints (hidden during moving/resizing and in window mode).
      positionCrosshair(event.clientX, event.clientY);
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
          setSnapRect(rectForSnap(next));
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
          // picking a window, not a rect. Stay in pending so mouseup
          // still lands the pick; a hand wobble must not cost it,
          // since there is no competing drag gesture to protect.
          if (modeRef.current === "window") return;
          // Past the threshold this is a drag, so it is not a click,
          // so it is not a pick. Disarm before anything else — the
          // armed window must not survive into the mouseup that ends
          // the free-draw.
          pendingPickRef.current = null;
          // A free-draw replaces the selection outright, so an existing
          // pick set goes with it. Not clearing here would leave
          // `commit()` on the pick path, shipping the old windows and
          // silently discarding the rect the user just drew.
          clearPickSet();
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
      // The HUD owns its own clicks, on release as much as on press —
      // `onMouseDown` and `onMouseMove` both already bail here. Without
      // the guard, a press that started on the canvas and was released
      // over the toolbar was consumed as a canvas gesture: in `window`
      // mode (where travel never promotes to `drawing`) dragging onto a
      // HUD button toggled a pick for the window under the ORIGINAL
      // press while the button the user released on got no click.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-region-hud]") !== null
      ) {
        pendingPickRef.current = null;
        clearDiscardPending();
        if (interactionRef.current.kind === "pending") {
          setInteraction({ kind: "snap" });
        }
        return;
      }
      const i = interactionRef.current;
      // Clear the discard-pending dim on ANY mouseup — including when
      // Esc/Enter already stepped the interaction back to snap/adjusting
      // before the button was released (the early-return below would
      // otherwise skip the clear and leave the rect dimmed).
      document.body.dataset.discarding = "false";
      if (i.kind === "snap" || i.kind === "adjusting") return;
      event.preventDefault();
      switch (i.kind) {
        case "pending": {
          // The button came up without the pointer travelling: this
          // was a click, not a drag. If a window was armed on the
          // press, that click is a pick — toggle it and stop. This is
          // the branch that makes plain click add/remove windows in
          // Quick Capture as well as in window mode.
          const armed = pendingPickRef.current;
          pendingPickRef.current = null;
          if (armed !== null) {
            discardingRef.current = false;
            togglePick(armed);
            return;
          }
          // A click that armed nothing while a set is live: keep the
          // set and stay put. Falling through would park the
          // interaction in `adjusting`, which stops mousemove from
          // tracking snap — so hovering the next window would show no
          // highlight and "click to add another" would stop reading.
          if (picksRef.current.length > 0) {
            discardingRef.current = false;
            // Back to `snap`, not left in `pending`: a lingering
            // `pending` keeps its mousedown coordinates, so the next
            // bare mousemove would measure against them and promote to
            // `drawing` with no button held.
            setInteraction({ kind: "snap" });
            return;
          }
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
          // Clicking a window used to BE the capture. It no longer is:
          // a press over a window arms a pick, which the branch above
          // consumed, so anything reaching here missed every window and
          // `snapAtPress` is a display target. Commit is now ↵ or the
          // HUD button.
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
      if (escapeTimerRef.current !== null) clearTimeout(escapeTimerRef.current);
    };
    // commit/cancel close over refs only; safe to leave deps empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAdjustable = interaction.kind === "adjusting";
  const isSnap = interaction.kind === "snap" || interaction.kind === "pending";
  const hasPicks = picks.length > 0;
  const dimsChipPosition: { left: number; top: number } | null = {
    left: rect.x,
    top: rect.y > 30 ? rect.y - 30 : rect.y + rect.h + 6
  };

  // ---- Multi-select mask geometry -------------------------------------
  //
  // The dim mask IS the output preview. In `windows` mode there is one
  // hole per picked extent, so the undimmed pixels are exactly the
  // pixels the PNG keeps; everything else inside the union box gets the
  // alpha checker because it becomes transparent. In `rectangle` mode
  // there is one hole — the union box itself — because the whole box is
  // kept opaque.
  //
  // Drawn with an SVG <mask>, NOT an even-odd path. Even-odd cancels
  // where two subpaths overlap, so two overlapping picked windows (a
  // dialog over its parent — the exact case Tab-cycling exists for)
  // would paint their intersection as dimmed and alpha-checkered while
  // the composite keeps those pixels opaque. Masking is union-shaped:
  // black over black is still black.
  const holes: Rect[] = !hasPicks
    ? []
    : outputMode === "windows"
      ? picks.map((p) => p.rawRect)
      : [rect];
  // Hovering an un-picked window while a set is live: show where the
  // next click would land. The main rect is pinned to the union, so
  // without this there is no feedback that the click does anything.
  const hoverEntry =
    hasPicks &&
    isSnap &&
    snapTarget.kind === "window" &&
    !picks.some((p) => p.windowId === snapTarget.entry.windowId)
      ? snapTarget.entry
      : null;

  // Hint copy varies by mode + snap target so the user always knows
  // what action is bound to click / drag / arrows.
  const hint = (() => {
    // Multi-select owns the legend while a pick set is live — the
    // single-selection keys (⇧ full-window, drag-region, arrows) either
    // don't apply to a derived union box or would silently drop the set.
    if (hasPicks) {
      return (
        <>
          <span>
            <kbd>click</kbd>add / remove window
          </span>
          {picks.length > 1 && (
            <>
              <span className="region-hint-sep">·</span>
              <span>
                <kbd>T</kbd>
                {outputMode === "windows" ? "keep whole box" : "transparent gaps"}
              </span>
            </>
          )}
          <span className="region-hint-sep">·</span>
          <span>
            <kbd>tab</kbd>next window
          </span>
          {picks.length === 1 && (
            <>
              <span className="region-hint-sep">·</span>
              <span>
                <kbd>arrows</kbd>nudge
              </span>
            </>
          )}
          <span className="region-hint-sep">·</span>
          <span>
            <kbd>↵</kbd>capture
          </span>
        </>
      );
    }
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
      // Window mode: click adds the highlighted window to the pick
      // set; ↵ (or the HUD button) captures. No drag, no ⇧ (full-window
      // is implied). Click used to commit directly — accumulating is
      // the point of the mode, and a one-window pick still commits in
      // two keystrokes.
      if (mode === "window") {
        const what =
          snapTarget.kind === "window"
            ? snapTarget.entry.appName ?? "window"
            : "—";
        return (
          <>
            <span>
              <kbd>click</kbd>add {what}
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>tab</kbd>next window
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>↵</kbd>capture
            </span>
          </>
        );
      }
      // Auto mode (Quick Capture, ⌘⇧C). Click picks the highlighted window
      // and keeps picking — the same accumulate-then-commit model as
      // window mode, because Quick Capture is the path most people
      // live in and multi-window has no reason to be locked out of it.
      // Drag still free-draws a region: the two gestures are told apart
      // on mouseup, not on press (see pickCandidateFor).
      const overWindow = snapTarget.kind === "window";
      const what = overWindow
        ? (snapTarget.entry.appName ?? "window")
        : "display";
      const isFullWindow = shiftHeld && overWindow;
      // `runInteractiveRecord` opens the RECORD picker as
      // `mode: "auto", intent: "video"`, so this copy is shared with a
      // surface where `multiSelectAllowed()` is false and a click
      // cannot pick anything — it drops into `adjusting` like it always
      // did. Derive the verb from the same capability the gesture
      // reads, or the record picker advertises a binding it lacks.
      const clickPicks = overWindow && multiSelectAllowed();
      return (
        <>
          <span>
            <kbd>click</kbd>
            {clickPicks ? (isFullWindow ? `pick full ${what}` : `pick ${what}`) : `select ${what}`}
          </span>
          {overWindow && !shiftHeld && (
            <>
              <span className="region-hint-sep">·</span>
              <span>
                <kbd>{shiftKey}</kbd>full window
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
            <kbd>↵</kbd>capture
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
            <kbd>arrows</kbd>nudge (<kbd>{shiftKey}</kbd>×10)
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
          // Ack to main once the frozen snapshot has loaded/decoded.
          // Main gates `win.show()` on this so the selector window is
          // never revealed as an empty transparent overlay (which would
          // flash the live screen behind it). Fires while the window is
          // still hidden — onLoad doesn't require a visible paint.
          onLoad={() => window.pwrsnapApi?.notifySelectorSnapshotPainted(screenUrl)}
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
      {/* Dim mask. Two implementations, one job — everything outside
          the selection is dimmed, and the undimmed pixels are exactly
          what gets captured.

          Single selection: four quadrant divs around the rect (cheap,
          and what has shipped since Phase 1.10).

          Multi-select: an SVG <mask>, because a pick set has disjoint
          holes and quadrants cannot express those. The mask is sized in
          CSS (inset:0, width/height 100%) rather than from a measured
          viewport, so a window resize — main calls setBounds on
          `display-metrics-changed`, which on macOS includes a menu-bar
          show/hide — cannot leave an undimmed strip along an edge. */}
      {hasPicks ? (
        <svg className="region-mask" aria-hidden>
          <defs>
            {/* Transparency checker. The renderer's own alpha checkers
                (editor.css / library.css) use 7%; this one is lighter-
                weight on purpose — it sits over a dimmed screenshot,
                not over a panel background. Tones come from region.css
                so every color in this surface stays in the stylesheet. */}
            <pattern
              id="region-alpha-checker"
              width="12"
              height="12"
              patternUnits="userSpaceOnUse"
            >
              <rect className="region-mask__checker-a" width="12" height="12" />
              <rect className="region-mask__checker-b" width="6" height="6" />
              <rect className="region-mask__checker-b" x="6" y="6" width="6" height="6" />
            </pattern>
            {/* White keeps, black cuts. Overlapping holes just stay
                black, which is the whole reason this is a mask and not
                an even-odd path. */}
            <mask id="region-mask-holes" maskUnits="userSpaceOnUse">
              <rect x="0" y="0" width="100%" height="100%" fill="white" />
              {holes.map((h, idx) => (
                <rect
                  key={idx}
                  x={h.x}
                  y={h.y}
                  width={Math.max(0, h.w)}
                  height={Math.max(0, h.h)}
                  fill="black"
                />
              ))}
            </mask>
          </defs>
          <rect
            className="region-mask__dim"
            x="0"
            y="0"
            width="100%"
            height="100%"
            mask="url(#region-mask-holes)"
          />
          {outputMode === "windows" && (
            <rect
              className="region-mask__alpha"
              x={rect.x}
              y={rect.y}
              width={Math.max(0, rect.w)}
              height={Math.max(0, rect.h)}
              fill="url(#region-alpha-checker)"
              mask="url(#region-mask-holes)"
            />
          )}
        </svg>
      ) : (
        <>
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
        </>
      )}

      {/* Per-pick outline + ordinal badge. The ordinal is the chip
          order in the HUD, so a user can tell which chip drops which
          window before clicking it. */}
      {picks.map((p, idx) => (
        <div
          key={p.windowId}
          className="region-pick"
          data-testid="region-pick"
          data-window-id={p.windowId}
          style={{
            left: p.rawRect.x,
            top: p.rawRect.y,
            width: p.rawRect.w,
            height: p.rawRect.h
          }}
        >
          <span className="region-pick__badge">{idx + 1}</span>
        </div>
      ))}

      {/* Next-click preview while a set is live. */}
      {hoverEntry !== null && (
        <div
          className="region-pick-hover"
          style={{
            left: hoverEntry.rawRect.x,
            top: hoverEntry.rawRect.y,
            width: hoverEntry.rawRect.w,
            height: hoverEntry.rawRect.h
          }}
        >
          <span className="region-pick__badge region-pick__badge--add">+</span>
        </div>
      )}

      {/* The selection frame. Skipped at exactly one pick: the union
          box and that pick's box are the same rectangle, and drawing
          both puts a dashed border under a solid one. The pick box wins
          because it carries the ordinal badge. */}
      {!(hasPicks && picks.length === 1) && (
      <div
        className={
          "region-rect" +
          (isAdjustable ? " region-rect--adjustable" : "") +
          // With a pick set live the rect is the derived union box, not
          // a snap target — never style it as one, or a two-window pick
          // reads as a single-window snap.
          (hasPicks
            ? ` region-rect--union region-rect--union-${outputMode}`
            : isSnap
              ? ` region-rect--snap-${snapTarget.kind}`
              : "")
        }
        data-testid="region-rect"
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
      )}

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
          {hasPicks ? (
            <>
              {picks.length} {picks.length === 1 ? "window" : "windows"} ·{" "}
              {Math.round(rect.w)} × {Math.round(rect.h)}
            </>
          ) : isSnap && snapTarget.kind === "window" ? (
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

      {/* Multi-select HUD. The one part of the overlay that takes its
          own clicks (see the [data-region-hud] guard in onMouseDown) —
          everything else is a canvas gesture. Rendered only while a
          pick set exists so single-selection capture is untouched. */}
      {hasPicks && (
        <div
          className="region-hud"
          data-region-hud
          data-testid="region-hud"
          // A HUD press deliberately skips preventDefault so the button
          // takes focus and its onClick fires. But a focused <button>
          // is then activated by Space, and the window-level Space
          // handler only preventDefaults while `adjusting` — a pick set
          // parks the interaction in `snap`. Left alone, Space on the
          // focused Capture button submits the capture, which is bound
          // nowhere in the hint bar. Drop focus once the click is done.
          onClick={(e) => {
            // `e.target` is the DEEPEST node — a chip's <span>, or the
            // Capture button's <kbd> — and blur() on a non-focusable
            // node is a no-op, so the <button> kept focus.
            if (e.target instanceof HTMLElement) e.target.closest("button")?.blur();
          }}
        >
          {/* Output shape. Hidden at one pick, where the union box is
              the extent and both modes produce identical pixels. */}
          {picks.length > 1 && (
            <>
              <div className="region-hud__seg" role="group" aria-label="Output shape">
                <button
                  type="button"
                  className="region-hud__seg-btn"
                  data-active={outputMode === "windows"}
                  data-testid="region-hud-mode-windows"
                  onClick={() => setOutputMode("windows")}
                  title="Keep only the picked windows; the gaps between them become transparent"
                >
                  Windows
                </button>
                <button
                  type="button"
                  className="region-hud__seg-btn"
                  data-active={outputMode === "rectangle"}
                  data-testid="region-hud-mode-rectangle"
                  onClick={() => setOutputMode("rectangle")}
                  title="Keep the whole bounding box, including what is between the windows"
                >
                  Rectangle
                </button>
              </div>
              <span className="region-hud__sep" />
            </>
          )}
          <div className="region-hud__chips">
            {picks.map((p, idx) => (
              <button
                key={p.windowId}
                type="button"
                className="region-hud__chip"
                data-testid="region-hud-chip"
                onClick={() => togglePick(p)}
                title={`Remove ${p.appName ?? "window"}`}
              >
                <span className="region-hud__chip-n">{idx + 1}</span>
                <span className="region-hud__chip-name">{p.appName ?? "Window"}</span>
                <span className="region-hud__chip-x" aria-hidden>
                  ×
                </span>
              </button>
            ))}
          </div>
          <span className="region-hud__sep" />
          <button
            type="button"
            className="region-hud__go"
            data-testid="region-hud-capture"
            onClick={() => commit()}
          >
            Capture<kbd>↵</kbd>
          </button>
        </div>
      )}

      <div className="region-hint">
        {intent === "video" && (
          <>
            <span>
              <kbd>click / drag</kbd>start recording
            </span>
            <span className="region-hint-sep">·</span>
            <span>
              <kbd>C</kbd>cursor: {captureCursor ? "on" : "off"}
            </span>
            <span className="region-hint-sep">·</span>
          </>
        )}
        {hint}
        <span className="region-hint-sep">·</span>
        <span>
          {/* Single source of the Esc affordance. Mirrors handleEscape,
              which checks the PICK SET FIRST — `togglePick` parks the
              interaction in `snap` while picks are live, so reading
              `interaction.kind` alone said "cancel" for a state Esc
              actually steps back from. */}
          <kbd>esc</kbd>
          {interaction.kind === "snap" && !hasPicks ? "cancel" : "back"}
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
